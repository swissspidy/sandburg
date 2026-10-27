/**
 * Checks that run out of time (src/orchestrator/checks.ts): a check stopped at its timeout stops
 * acting on the app, which loads again before the next check; a checks phase stopped at its deadline
 * keeps what finished. On the host and in the page (--checks-in page). In Chromium.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { ChecksProgress, runChecks, type Checks, type ChecksInput } from '../../src/orchestrator/checks.ts';
import type { PageChecks } from '../../src/page-checks/index.ts';
import type { CheckResult } from '../../src/types.ts';
import { tempDir } from '../unit/temp-dir.ts';

let browser: Browser;
let page: Page;
let app: Frame;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
});
after(() => browser.close());

/**
 * The sandbox tab (a page with a language and a title, for axe-core): the app in its #app frame. The
 * app has a text field, and a button "Later" once the tab's clock passes window.laterAt (a check sets
 * it); clicking it counts on the tab (window.laterClicks), which outlives the app's reloads.
 */
const doc = (body: string) => `<!doctype html><html lang="en"><title>checks</title><main><h1>Checks</h1>${body}</main></html>`;
const APP = doc(`<label>Name <input></label><script>
  const timer = setInterval(() => {
    if (!parent.laterAt || Date.now() < parent.laterAt) return;
    clearInterval(timer);
    const b = document.createElement('button');
    b.textContent = 'Later';
    b.onclick = () => (parent.laterClicks = (parent.laterClicks ?? 0) + 1);
    document.querySelector('main').append(b);
  }, 20);
</script>`);

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
  await page.route('http://checks.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: new URL(r.request().url()).pathname.startsWith('/app/') ? APP : doc('<iframe id="app" title="app" src="/app/"></iframe>') }),
  );
  await page.goto('http://checks.test/');
  app = page.frame({ url: 'http://checks.test/app/' })!;
  await app.waitForLoadState('load');
});

const input = (checks: ChecksInput['checks'], more: Partial<ChecksInput> = {}): ChecksInput => ({
  page,
  app,
  checks,
  checkTimeoutMs: 1_000,
  expectTimeoutMs: 5_000,
  artifactsDir: tempDir('sandburg-check-timeouts-'),
  appErrors: () => [],
  appConsole: () => [],
  network: () => ({ failed: [], blocked: [] }),
  ...more,
});
const byName = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.name, c]));
const pageChecks = (code: string): PageChecks => ({ kind: 'page', file: 'checks.js', code });
/** How long the tab is watched for a click the stopped check would make: one lands within a frame or two of the button showing. */
const WATCH_MS = 500;

test('a check stopped at its timeout stops clicking, and the next check sees the app loaded again', async () => {
  const checks: Checks = {
    'hangs waiting for a button': async ({ app, page }) => {
      await app.getByLabel('Name').fill('left over');
      // The button shows after the check's 1 s, in the next check: a click still pending would land there.
      await page.evaluate(() => ((window as unknown as { laterAt: number }).laterAt = Date.now() + 1_500));
      await app.getByRole('button', { name: 'Later' }).click({ timeout: 10_000 });
    },
    'runs after it': async ({ app, expect }) => {
      await expect(app.getByLabel('Name')).toHaveValue('');
      await app.getByRole('button', { name: 'Later' }).click();
    },
  };
  const { checks: results } = await runChecks(input(checks));
  const r = byName(results);
  assert.equal(r['hangs waiting for a button'].status, 'failed');
  assert.match(r['hangs waiting for a button'].message!, /check "hangs waiting for a button" timed out\nThe check was stopped, and the app loaded again before the next check\./);
  assert.equal(r['runs after it'].status, 'passed', JSON.stringify(r['runs after it']));
  await page.waitForTimeout(WATCH_MS);
  assert.equal(await page.evaluate(() => (window as unknown as { laterClicks?: number }).laterClicks), 1, 'only the second check clicked');
});

test('a check stopped inside toPass is not retried after it', async () => {
  let tries = 0;
  const checks: Checks = {
    retries: async ({ app, expect }) => {
      await expect(async () => {
        tries++;
        await app.getByRole('button', { name: 'Never' }).click({ timeout: 50 });
      }).toPass();
    },
  };
  const { checks: results } = await runChecks(input(checks));
  assert.equal(byName(results).retries.status, 'failed');
  const stopped = tries;
  await page.waitForTimeout(1_200); // longer than toPass's longest interval (1 s)
  assert.equal(tries, stopped);
});

test('a checks phase stopped at its deadline keeps what finished, fails the running check and skips the rest', async () => {
  const progress = new ChecksProgress();
  const phase = new AbortController();
  let hanging!: () => void;
  const started = new Promise<void>((resolve) => (hanging = resolve));
  const checks: Checks = {
    'passes first': async ({ app, expect }) => {
      await expect(app.getByLabel('Name')).toBeVisible();
    },
    hangs: async ({ app }) => {
      hanging();
      await app.getByRole('button', { name: 'Never' }).click();
    },
    'never starts': async () => {},
  };
  const running = runChecks(input(checks, { checkTimeoutMs: 30_000, progress, signal: phase.signal }));
  await started;
  const t = performance.now();
  phase.abort(new Error('checks did not finish within 1000 ms'));
  await running;
  assert.ok(performance.now() - t < 2_000, 'the click it waited in was aborted');
  progress.close('checks did not finish within 1000 ms');

  const r = byName(progress.checks);
  assert.deepEqual(
    progress.checks.map((c) => [c.id, c.status]),
    [
      ['screenshot', 'passed'],
      ['a11y-snapshot', 'passed'],
      ['axe', 'passed'],
      ['functional:passes-first', 'passed'],
      ['functional:hangs', 'failed'],
      ['functional:never-starts', 'skipped'],
      ['document', 'skipped'],
      ['console', 'skipped'],
      ['network', 'skipped'],
    ],
  );
  assert.equal(r.hangs.message, 'timed out: checks did not finish within 1000 ms');
  assert.equal(r['never starts'].message, 'not run: checks did not finish within 1000 ms');
  await access(progress.artifacts.screenshot!);
  await access(progress.artifacts.a11ySnapshot!);
});

test('in the page: a check stopped at its timeout stops clicking, and the next check sees the app loaded again', async () => {
  const code = `export default {
    'hangs waiting for a button': async ({ app }) => {
      await app.getByLabel('Name').fill('left over');
      window.laterAt = Date.now() + 1500;
      await app.getByRole('button', { name: 'Later' }).click({ timeout: 10000 });
    },
    'runs after it': async ({ app, expect }) => {
      await expect(app.getByLabel('Name')).toHaveValue('');
      await app.getByRole('button', { name: 'Later' }).click();
    },
  };`;
  const { checks: results } = await runChecks(input(pageChecks(code)));
  const r = byName(results);
  assert.equal(r['hangs waiting for a button'].status, 'failed');
  assert.match(r['hangs waiting for a button'].message!, /timed out\nThe check was stopped, and the app loaded again before the next check\./);
  assert.equal(r['runs after it'].status, 'passed', JSON.stringify(r['runs after it']));
  await page.waitForTimeout(WATCH_MS);
  assert.equal(await page.evaluate(() => (window as unknown as { laterClicks?: number }).laterClicks), 1, 'only the second check clicked');
});

test('in the page: a checks phase stopped at its deadline keeps what finished', async () => {
  const progress = new ChecksProgress();
  const phase = new AbortController();
  const code = `export default {
    'passes first': async ({ app, expect }) => {
      await expect(app.getByLabel('Name')).toBeVisible();
    },
    hangs: async ({ app }) => {
      window.hanging = true;
      await app.getByRole('button', { name: 'Never' }).click();
    },
    'never starts': async () => {},
  };`;
  const running = runChecks(input(pageChecks(code), { checkTimeoutMs: 30_000, progress, signal: phase.signal }));
  await page.waitForFunction(() => (window as unknown as { hanging?: boolean }).hanging);
  phase.abort(new Error('checks did not finish within 1000 ms'));
  await running;
  progress.close('checks did not finish within 1000 ms');

  assert.deepEqual(
    progress.checks.filter((c) => c.kind === 'functional').map((c) => [c.name, c.status, c.message]),
    [
      ['passes first', 'passed', undefined],
      ['hangs', 'failed', 'timed out: checks did not finish within 1000 ms'],
      ['never starts', 'skipped', 'not run: checks did not finish within 1000 ms'],
    ],
  );
  assert.deepEqual(
    progress.checks.filter((c) => c.kind !== 'functional').map((c) => c.status),
    ['passed', 'passed', 'passed', 'skipped', 'skipped', 'skipped'],
  );
});
