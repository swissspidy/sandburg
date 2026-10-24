/** settlingExpect (src/orchestrator/checks.ts): assertions that stop waiting once the app is idle. In Chromium. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { settlingExpect } from '../../src/orchestrator/checks.ts';
import { PAGE_QUIET_SCRIPT } from '../../src/orchestrator/session.ts';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
  page = await browser.newPage();
});
after(() => browser.close());

const opts = { floorMs: 500, sliceMs: 200 };
const timed = async (fn: () => Promise<unknown>) => {
  const t = performance.now();
  const error = await fn().then(() => null, (e: Error) => e);
  return { ms: performance.now() - t, error };
};

test('a failing assertion stops after the floor when the app is idle', async () => {
  await page.setContent('<h1>broken</h1>');
  const e = settlingExpect(expect, 10_000, async () => true, opts);
  const { ms, error } = await timed(() => e(page.locator('h1')).toHaveText('fixed'));
  assert.ok(error, 'the assertion fails');
  assert.match(error!.message, /Expected: "fixed"[\s\S]*Stopped waiting after [\d.]+ s of 10 s: the app was idle/);
  assert.ok(ms < 2_000, `stopped early (${Math.round(ms)} ms)`);
});

test('while the app is busy, an assertion keeps waiting past the floor and passes', async () => {
  await page.setContent('<h1>compiling</h1><script>setTimeout(() => (document.querySelector("h1").textContent = "ready"), 1500)</script>');
  const e = settlingExpect(expect, 10_000, async () => false, opts);
  const { ms, error } = await timed(() => e(page.locator('h1')).toHaveText('ready'));
  assert.equal(error, null);
  assert.ok(ms > 1_000 && ms < 4_000, `${Math.round(ms)} ms`);
});

test('a busy app that never gets there fails at the full timeout', async () => {
  await page.setContent('<h1>broken</h1>');
  const e = settlingExpect(expect, 1_500, async () => false, opts);
  const { ms, error } = await timed(() => e(page.locator('h1')).toHaveText('fixed'));
  assert.ok(error && !/Stopped waiting/.test(error.message));
  assert.ok(ms >= 1_400 && ms < 3_000, `${Math.round(ms)} ms`);
});

test('.not, synchronous matchers, an own timeout and expect members work as in Playwright', async () => {
  await page.setContent('<h1>hi</h1>');
  const e = settlingExpect(expect, 10_000, async () => true, opts);
  await e(page.locator('h1')).not.toHaveText('bye');
  await e(page.locator('h1')).toHaveText('hi');
  assert.throws(() => e(1).toBe(2));
  e(1).toBe(1);
  // An own timeout is kept, and the assertion does not settle early.
  const { ms, error } = await timed(() => e(page.locator('h1')).toHaveText('bye', { timeout: 1_200 }));
  assert.ok(error && !/Stopped waiting/.test(error.message) && ms >= 1_100, `${Math.round(ms)} ms`);
  await e.poll(async () => 42).toBe(42);
  assert.equal(typeof e.soft, 'function');
});

test('expect.poll keeps the configured timeout (not Playwright\'s 5 s default)', async () => {
  const e = settlingExpect(expect, 8_000, async () => true, opts);
  const t = performance.now();
  await e.poll(() => performance.now() - t > 5_500, { intervals: [250] }).toBe(true);
});

test('with the page-quiet script, a page that updates itself from a timer is not idle until then', async () => {
  const p = await browser.newPage();
  await p.addInitScript(PAGE_QUIET_SCRIPT);
  // Init scripts run in documents a navigation loads (setContent on about:blank would not run it).
  await p.route('http://quiet.test/', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>loading</h1><script>setTimeout(() => (document.querySelector("h1").textContent = "loaded"), 1500)</script>' }));
  await p.goto('http://quiet.test/');
  // As the session decides (its servers being idle here): no timer due in the time left, no recent change.
  const idle = async (left: number) => {
    const q = await p.evaluate((h) => (window as unknown as { __sandburgQuiet(h: number): { quiet: boolean; sinceChangeMs: number } }).__sandburgQuiet(h), left);
    return q.quiet && q.sinceChangeMs >= 300;
  };
  const e = settlingExpect(expect, 10_000, idle, opts);
  await e(p.locator('h1')).toHaveText('loaded');
  // Nothing pending any more: a wrong expectation stops early.
  const { ms, error } = await timed(() => e(p.locator('h1')).toHaveText('never'));
  assert.ok(error && /Stopped waiting/.test(error.message) && ms < 3_000, `${Math.round(ms)} ms`);
  await p.close();
});

test('an assertion that waits is checked more often than Playwright polls: it passes soon after the page changes', async () => {
  // Playwright polls at ~0, 20, 70, 170, 270, 770, 1270 ms: a change at 900 ms is seen at ~1270 ms.
  const change = '<h1>posting</h1><script>setTimeout(() => (document.querySelector("h1").textContent = "posted"), 900)</script>';
  await page.setContent(change);
  const plain = await timed(() => expect(page.locator('h1')).toHaveText('posted', { timeout: 5_000 }));
  await page.setContent(change);
  const e = settlingExpect(expect, 5_000, async () => false);
  const probed = await timed(() => e(page.locator('h1')).toHaveText('posted'));
  assert.equal(plain.error, null);
  assert.equal(probed.error, null);
  assert.ok(plain.ms > 1_200, `Playwright alone: ${Math.round(plain.ms)} ms`);
  assert.ok(probed.ms < 1_150, `probed: ${Math.round(probed.ms)} ms`);
  // An own timeout too, and .not.
  await page.setContent(change);
  const own = await timed(() => e(page.locator('h1')).toHaveText('posted', { timeout: 3_000 }));
  assert.ok(own.error === null && own.ms < 1_150, `own timeout: ${Math.round(own.ms)} ms`);
  await page.setContent(change);
  const not = await timed(() => e(page.locator('h1')).not.toHaveText('posting'));
  assert.ok(not.error === null && not.ms < 1_150, `.not: ${Math.round(not.ms)} ms`);
});

test('once a check beside it passes, the assertion starts no further attempts', async () => {
  // A state the check beside it saw and the assertion then missed: the assertion keeps timing out,
  // its one-shot checks (timeout 1 ms) pass.
  let attempts = 0;
  let idleCalls = 0;
  const base = {
    configure: ({ timeout }: { timeout: number }) => () => ({
      toHaveText: () =>
        timeout === 1
          ? Promise.resolve()
          : (attempts++, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timed out'), { matcherResult: { timeout } })), timeout))),
    }),
  } as unknown as typeof expect;
  const e = settlingExpect(base, 3_000, async () => (idleCalls++, false), opts);
  const { error } = await timed(() => e({ locator() {}, evaluate() {} } as unknown as Locator).toHaveText('posted'));
  assert.equal(error, null);
  // The assertion's own attempt ends at the floor (500 ms); after it, nothing more is tried.
  await new Promise((r) => setTimeout(r, 1_500));
  assert.deepEqual({ attempts, idleCalls }, { attempts: 1, idleCalls: 0 });
});

test('a failing assertion fails as it would without the checks beside it: same message, same time', async () => {
  await page.setContent('<h1>broken</h1>');
  const e = settlingExpect(expect, 1_500, async () => false, opts);
  const probed = await timed(() => e(page.locator('h1')).toHaveText('fixed', { timeout: 1_200 }));
  const plain = await timed(() => expect(page.locator('h1')).toHaveText('fixed', { timeout: 1_200 }));
  assert.ok(probed.error && plain.error);
  const strip = (m: string) => m.replace(/\u001b\[[0-9;]*m/g, '').replace(/\d+ × /g, 'N × ');
  assert.equal(strip(probed.error!.message), strip(plain.error!.message));
  assert.ok(probed.ms >= 1_150 && probed.ms < 1_700, `${Math.round(probed.ms)} ms`);
});

test("toPass and expect(value) are not checked beside the assertion: a callback runs only as Playwright runs it", async () => {
  await page.setContent('<h1>x</h1>');
  const e = settlingExpect(expect, 5_000, async () => false, opts);
  let calls = 0;
  const t = performance.now();
  await e(async () => {
    calls++;
    if (performance.now() - t < 900) throw new Error('not yet');
  }).toPass({ timeout: 3_000, intervals: [400] });
  assert.ok(calls <= 4, `${calls} calls`);
  await assert.rejects(e(Promise.resolve(1)).resolves.toBe(2));
});
