/** settlingExpect (src/orchestrator/checks.ts): assertions that stop waiting once the app is idle. In Chromium. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { settlingExpect } from '../../src/orchestrator/checks.ts';

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
  assert.match(error!.message, /Expected: "fixed"[\s\S]*Stopped waiting after [\d.]+ s of 10 s: the app's servers were idle/);
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
