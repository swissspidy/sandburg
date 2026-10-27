/**
 * Checks that run in the page (`--checks-in page`): the checks file's code runs in Sandburg's tab,
 * next to the app's frame, not in Sandburg's Node process. The tab and the app share an origin
 * (ADR 0004), so the checks can do no more than the app's own code. They get a Playwright-shaped
 * `app`, `page` and `expect`:
 *
 * - locators are Playwright's selectors, resolved by ivya (a fork of Playwright's locator
 *   resolution): the same getByRole, getByLabel, getByText … matching as on the host;
 * - input comes from Testing Library's user-event (pointer, keyboard and focus events in order),
 *   and fill() inserts text as Playwright does (one input event). Events made by a script are not
 *   trusted (`isTrusted` is false): CSS :hover does not apply, and a native select's list does not
 *   open;
 * - actions and assertions wait as Playwright's do, for the element to appear, be visible and
 *   enabled, or for the assertion to hold.
 *
 * Bundled by page-checks/index.ts; installed as window.__sandburgPageChecks.
 */
import { userEvent } from '@testing-library/user-event';

import type { PageCheckResult, PageChecksOptions, PageChecksOutput } from './types.ts';
import { modifier, escapeKeys, keySequence } from './locator.ts';
import { makeExpect } from './expect.ts';
import { settings, running, appWindow, appDocument, sleep, message, named, isFailure, guarded } from './frame.ts';
import { App } from './app.ts';

// --- the page ----------------------------------------------------------------------------------

/** The keyboard, on the element that has focus in the app. */
const keyboard = {
  press: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(keySequence(key)),
  type: (text: string) => userEvent.setup({ document: appDocument() }).keyboard(escapeKeys(text)),
  insertText: async (text: string) => void appDocument().execCommand('insertText', false, text),
  down: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(`{${modifier(key)}>}`),
  up: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(`{/${modifier(key)}}`),
};

// --- running a checks file ---------------------------------------------------------------------

async function run(source: string, options: PageChecksOptions): Promise<PageChecksOutput> {
  Object.assign(settings, options);
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let mod: { default?: unknown };
  try {
    mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } catch (e) {
    return { error: `the checks file did not load: ${message(e)}` };
  } finally {
    URL.revokeObjectURL(url);
  }
  const checks = mod.default;
  if (!checks || typeof checks !== 'object' || Object.values(checks).some((fn) => typeof fn !== 'function')) {
    return { error: 'the checks file must default-export an object mapping check names to functions' };
  }
  const start = appWindow().location.href;
  const app = new App(new URL('.', start).href);
  const context = {
    app: guarded(app, 'app'),
    page: guarded({ keyboard, waitForTimeout: (ms: number) => sleep(ms), goto: app.goto.bind(app), reload: app.reload.bind(app), url: app.url.bind(app) }, 'page'),
    expect: makeExpect(options.expectTimeoutMs),
    appUrl: app.appUrl,
  };
  const results: PageCheckResult[] = [];
  const entries = Object.entries(checks as Record<string, (ctx: typeof context & { signal: AbortSignal }) => unknown>);
  progress = { results, pending: entries.map(([name]) => name), stopped: false };
  for (const [name, fn] of entries) {
    if (progress.stopped) break;
    progress.pending.shift();
    const controller = new AbortController();
    const started = performance.now();
    progress.running = { name, started, controller };
    running.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(named('TimeoutError', `check "${name}" timed out`)), options.checkTimeoutMs);
    let result: PageCheckResult;
    try {
      await Promise.race([
        Promise.resolve().then(() => fn({ ...context, signal: controller.signal })),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
      result = { name, status: 'passed', durationMs: Math.round(performance.now() - started) };
    } catch (e) {
      result = { name, status: isFailure(e) ? 'failed' : 'error', message: message(e), durationMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
      progress.running = undefined;
      running.signal = new AbortController().signal;
    }
    if (progress.stopped) break;
    results.push(result);
    // Stopped at its timeout: the app loads again where it first loaded, so what the check left half done does not reach the next one.
    if (controller.signal.aborted) {
      result.message += await app.goto(start).then(
        () => '\nThe check was stopped, and the app loaded again before the next check.',
        (e: unknown) => `\nThe check was stopped; loading the app again failed: ${message(e)}`,
      );
    }
  }
  return { results };
}

/** The checks of the run in progress: those that finished, the one running, those still to come. */
let progress: {
  results: PageCheckResult[];
  running?: { name: string; started: number; controller: AbortController };
  pending: string[];
  stopped: boolean;
} | null = null;

function stop(reason: string): PageChecksOutput {
  if (!progress) return { results: [] };
  progress.stopped = true;
  const { results, running: current, pending } = progress;
  current?.controller.abort(named('TimeoutError', reason));
  return {
    results: [
      ...results,
      ...(current ? [{ name: current.name, status: 'failed' as const, message: `timed out: ${reason}`, durationMs: Math.round(performance.now() - current.started) }] : []),
      ...pending.map((name) => ({ name, status: 'skipped' as const, message: `not run: ${reason}`, durationMs: 0 })),
    ],
  };
}

window.__sandburgPageChecks = { run, stop };
