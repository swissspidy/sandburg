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
  assert.match(error.message, /Expected: "fixed"[\s\S]*Stopped waiting after [\d.]+ s of 10 s: the app was idle/);
  assert.ok(ms < 2_000, `stopped early (${Math.round(ms)} ms)`);
});

test('while the app is busy, an assertion keeps waiting past the floor and passes', async () => {
  await page.setContent('<h1>compiling</h1>');
  // The page changes only once the floor has passed and the app was found busy: an assertion that
  // passes waited on past the floor.
  let busy = 0;
  const e = settlingExpect(
    expect,
    10_000,
    async () => {
      if (busy++ === 0) await page.evaluate(() => (document.querySelector('h1')!.textContent = 'ready'));
      return false;
    },
    opts,
  );
  await e(page.locator('h1')).toHaveText('ready');
  assert.ok(busy >= 1);
});

test('a busy app that never gets there fails at the full timeout', async () => {
  await page.setContent('<h1>broken</h1>');
  const e = settlingExpect(expect, 1_500, async () => false, opts);
  const { ms, error } = await timed(() => e(page.locator('h1')).toHaveText('fixed'));
  assert.ok(error && !/Stopped waiting/.test(error.message));
  // The whole 1.5 s (but the last 100 ms, too short for a slice), not the 0.5 s floor; and not much
  // past it.
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

/**
 * expect, with an assertion's own attempts held until `attempts` resolves; its one-shot checks
 * (timeout 1 ms) run at once, as in Playwright, and each calls `onCheck` once it has ended.
 */
function held(attempts: Promise<unknown>, onCheck: () => void): typeof expect {
  const wrap = (m: object, before: Promise<unknown>, after = () => {}): object =>
    new Proxy(m, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value === 'function') return (...args: unknown[]) => before.then(() => value.apply(target, args)).finally(after);
        return typeof value === 'object' && value !== null ? wrap(value, before, after) : value;
      },
    });
  return {
    configure: ({ timeout }: { timeout: number }) => {
      const configured = expect.configure({ timeout });
      return (...args: Parameters<typeof expect>) => (timeout === 1 ? wrap(configured(...args), Promise.resolve(), onCheck) : wrap(configured(...args), attempts));
    },
  } as unknown as typeof expect;
}

test('an assertion that waits is checked more often than Playwright polls: it passes soon after the page changes', async () => {
  // Playwright polls at ~0, 20, 70, 170, 270, 770, 1270 ms: a change at 900 ms is seen at ~1270 ms.
  // Here the assertion's own attempts are held until the end and the page changes once two checks
  // have failed: only a check beside the attempts can see the change, the next one (PROBE_EVERY_MS,
  // 100 ms, later), well before Playwright's next poll would have.
  const assertions: ((e: typeof expect, h1: Locator) => Promise<unknown>)[] = [
    (e, h1) => e(h1).toHaveText('posted'),
    // An own timeout too, and .not.
    (e, h1) => e(h1).toHaveText('posted', { timeout: 3_000 }),
    (e, h1) => e(h1).not.toHaveText('posting'),
  ];
  for (const assertion of assertions) {
    await page.setContent('<h1>posting</h1>');
    let start!: () => void;
    const attempts = new Promise<void>((r) => (start = r));
    let checked!: () => void;
    const twice = new Promise<void>((r) => (checked = r));
    let checks = 0;
    const passed = assertion(settlingExpect(held(attempts, () => ++checks === 2 && checked()), 5_000, async () => false), page.locator('h1'));
    // Without the checks, the attempts start after this and pass the assertion (rather than it hanging).
    const backstop = setTimeout(() => (start(), checked()), 5_000);
    await twice;
    await page.evaluate(() => (document.querySelector('h1')!.textContent = 'posted'));
    const changed = performance.now();
    const first = await Promise.race([passed.then(() => 'a check'), attempts.then(() => 'its own attempt')]);
    const ms = performance.now() - changed;
    clearTimeout(backstop);
    start();
    await passed;
    assert.equal(first, 'a check');
    // The next check (100 ms on) and its round trip: a slower cadence passes later (the timer only
    // waits longer on a loaded machine).
    assert.ok(ms < 450, `passed ${Math.round(ms)} ms after the change`);
  }
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
  const e = settlingExpect(expect, 10_000, async () => false, opts);
  const probed = await timed(() => e(page.locator('h1')).toHaveText('fixed', { timeout: 1_200 }));
  const plain = await timed(() => expect(page.locator('h1')).toHaveText('fixed', { timeout: 1_200 }));
  assert.ok(probed.error && plain.error);
  // The call log counts Playwright's attempts ("13 × locator resolved to …"), which vary with the
  // machine's speed, and indents the line under a count by the count's width: both are left out.
  const strip = (m: string) => m.replace(/\u001b\[[0-9;]*m/g, '').replace(/\d+ × /g, 'N × ').replace(/^ +/gm, '');
  assert.equal(strip('    5 × locator resolved to <h1>broken</h1>\n      - unexpected value "broken"'), strip('    13 × locator resolved to <h1>broken</h1>\n       - unexpected value "broken"'));
  assert.equal(strip(probed.error.message), strip(plain.error.message));
  // At its own timeout (1.2 s), not the configured 10 s.
  assert.ok(probed.ms >= 1_150 && probed.ms < 5_000, `${Math.round(probed.ms)} ms`);
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
