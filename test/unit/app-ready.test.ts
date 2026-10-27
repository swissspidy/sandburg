/** The ready phase's waits (src/orchestrator/app-ready.ts): when the app has rendered, and when to give up on it early. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from 'playwright-core';
import { failFastOnAppError, failFastOnRuntimeFetch, waitForRender } from '../../src/orchestrator/app-ready.ts';
import type { RunState } from '../../src/orchestrator/run-state.ts';
import type { ConsoleEntry, PageError } from '../../src/types.ts';

/** What the waits read of a run. */
const runState = () => ({
  network: { failed: [] as { url: string; reason: string }[] },
  console: [] as Partial<ConsoleEntry>[],
  pageErrors: [] as Partial<PageError>[],
  documents: [] as { url: string; status: number }[],
});
const asRun = (run: ReturnType<typeof runState>) => run as unknown as RunState;

/** How a promise has settled so far: its polls run on mocked timers, each when the test moves the clock. */
function watched(p: Promise<unknown>) {
  const state: { settled: 'pending' | 'resolved' | 'rejected'; error?: Error } = { settled: 'pending' };
  p.then(
    () => (state.settled = 'resolved'),
    (e: Error) => Object.assign(state, { settled: 'rejected', error: e }),
  );
  return state;
}
const turn = () => new Promise((r) => setImmediate(r));
/** Moves the mocked clock by `ms`, in steps of the waits' 100 ms polls, letting each poll finish. */
async function advance(t: TestContext, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 100) {
    t.mock.timers.tick(Math.min(100, left));
    await turn();
  }
}

test('a runtime asset that fails to load in the browser fails the phase after a grace period; other failures do not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const run = runState();
  const allow = (origin: string) => origin === 'https://cdn.test';
  const phase = watched(failFastOnRuntimeFetch(new Promise(() => {}), asRun(run), allow));
  // Not the runtime's own origin, or not failed in the browser: ignored.
  run.network.failed.push({ url: 'https://elsewhere.test/a.js', reason: 'browser:net::ERR_FAILED' }, { url: 'https://cdn.test/b.js', reason: 'blocked' });
  await advance(t, 5_000);
  assert.equal(phase.settled, 'pending');
  run.network.failed.push({ url: 'https://cdn.test/runtime.wasm', reason: 'browser:net::ERR_CONNECTION_RESET' });
  await advance(t, 200); // seen at the next poll
  // The runtime may retry it for 3 s.
  await advance(t, 2_900);
  assert.equal(phase.settled, 'pending');
  await advance(t, 300);
  assert.equal(phase.settled, 'rejected');
  assert.equal(phase.error?.message, 'runtime asset failed to load: https://cdn.test/runtime.wasm (browser:net::ERR_CONNECTION_RESET)');
});

test('a rate limit or server error on a script fails the phase too; work that ends first is its result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const run = runState();
  run.console.push({ type: 'error', text: 'Failed to register a ServiceWorker: A bad HTTP response code (429) was received' });
  const phase = watched(failFastOnRuntimeFetch(new Promise(() => {}), asRun(run), () => false));
  await advance(t, 3_200);
  assert.match(phase.error?.message ?? '', /^runtime asset failed to load: Failed to register a ServiceWorker/);
  // Work that ends within the grace period.
  let finish!: (v: string) => void;
  const done = failFastOnRuntimeFetch(new Promise<string>((r) => (finish = r)), asRun(run), () => false);
  await advance(t, 1_000);
  finish('ready');
  assert.equal(await done, 'ready');
});

test('an app that throws and does not render within 2 s fails with its error; one that renders in time does not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const run = runState();
  const phase = watched(failFastOnAppError(new Promise(() => {}), asRun(run)));
  // Not the app's (the host page's own).
  run.pageErrors.push({ source: 'host', message: 'host' });
  await advance(t, 5_000);
  assert.equal(phase.settled, 'pending');
  run.pageErrors.push({ source: 'app', message: 'x is not defined' });
  await advance(t, 1_900);
  assert.equal(phase.settled, 'pending');
  await advance(t, 300);
  assert.equal(phase.error?.message, 'app threw before rendering: x is not defined');

  let rendered!: () => void;
  const late = watched(failFastOnAppError(new Promise<void>((r) => (rendered = r)), asRun(run)));
  await advance(t, 1_000);
  rendered();
  await advance(t, 2_000);
  assert.equal(late.settled, 'resolved');
});

test("a console error waits 8 s; noise, and a dev server's 503 loading page, are not the app failing", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const run = runState();
  run.documents.push({ url: 'http://app.test/', status: 503 });
  run.console.push(
    { source: 'app', type: 'error', text: 'GET /favicon.ico 404' },
    { source: 'app', type: 'error', text: 'Failed to load resource: 503', url: 'http://app.test/' },
    { source: 'app', type: 'warning', text: 'deprecated' },
  );
  const phase = watched(failFastOnAppError(new Promise(() => {}), asRun(run)));
  await advance(t, 10_000);
  assert.equal(phase.settled, 'pending');
  run.console.push({ source: 'app', type: 'error', text: 'Failed to fetch dynamically imported module', url: 'http://app.test/src/main.ts' });
  await advance(t, 7_900);
  assert.equal(phase.settled, 'pending');
  await advance(t, 300);
  assert.equal(phase.error?.message, 'app did not render after a console error: Failed to fetch dynamically imported module (http://app.test/src/main.ts)');
});

test("what is logged while a dev server's loading page shows is the server's: not counted, and handed to the host", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const run = runState();
  let loadingPage = true;
  let rendered!: () => void;
  const phase = watched(failFastOnAppError(new Promise<void>((r) => (rendered = r)), asRun(run), async () => loadingPage));
  run.pageErrors.push({ source: 'app', message: 'building' });
  run.console.push({ source: 'app', type: 'error', text: 'GET / 503' });
  await advance(t, 10_000);
  assert.equal(phase.settled, 'pending');
  loadingPage = false;
  rendered();
  await advance(t, 100);
  assert.equal(phase.settled, 'resolved');
  assert.deepEqual([run.pageErrors[0].source, run.console[0].source], ['host', 'host']);
});

/**
 * A frame whose render checks answer `states` in turn ('rendered', 'waiting', 'error': the browser's
 * error page), then 'waiting'; its tab closes after 10 checks (a backstop: a wait that does not end fails).
 */
function frame(states: ('rendered' | 'waiting' | 'error')[], { detached = (): boolean => false } = {}) {
  let url = 'http://app.test/';
  const checks: string[] = [];
  const f = {
    isDetached: detached,
    page: () => ({ isClosed: () => checks.length >= 10 }),
    url: () => url,
    waitForFunction: async () => {
      const state = states.shift() ?? 'waiting';
      checks.push(state);
      url = state === 'error' ? 'chrome-error://chromewebdata/' : 'http://app.test/';
      if (state !== 'rendered') throw new Error('timed out');
    },
  };
  return { frame: f as unknown as Frame, checks };
}

test('an app is ready once its frame renders; the browser\'s error page is loaded again at once, a loading page every 5 tries', async () => {
  const reloads: number[] = [];
  const a = frame(['error', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'rendered']);
  await waitForRender(a.frame, undefined, async () => reloads.push(a.checks.length));
  assert.equal(a.checks.length, 7);
  // After the error page (try 1), and after try 5.
  assert.deepEqual(reloads, [1, 5]);
  // A render while the dev server's loading page shows is not the app.
  let loading = 2;
  const b = frame(['rendered', 'rendered', 'rendered']);
  await waitForRender(b.frame, undefined, undefined, () => loading-- > 0);
  assert.equal(b.checks.length, 3);
});

test('the host page is asked first; a frame that is gone ends the wait', async () => {
  const a = frame([]);
  await waitForRender(a.frame, '#root', undefined, () => false, async () => true);
  assert.deepEqual(a.checks, []);
  // One that fails: the frame is checked.
  const b = frame(['rendered']);
  await waitForRender(b.frame, undefined, undefined, undefined, () => Promise.reject(new Error('no host')));
  assert.deepEqual(b.checks, ['rendered']);
  let tries = 0;
  const gone = frame([], { detached: () => ++tries > 2 });
  await assert.rejects(waitForRender(gone.frame), /the app frame is gone/);
  assert.equal(gone.checks.length, 2);
});
