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
import { Ivya } from 'ivya';
import { userEvent } from '@testing-library/user-event';

import type { PageCheckResult, PageChecksOptions, PageChecksOutput } from './types.ts';
import { type Text, Locatable, Locator, modifier, escapeKeys, keySequence } from './locator.ts';
import { makeExpect } from './expect.ts';

export const ivya = Ivya.create({ browser: 'chromium', testIdAttribute: 'data-testid' });
export let settings: PageChecksOptions = { checkTimeoutMs: 30_000, expectTimeoutMs: 5_000 };

// --- the app's frame ---------------------------------------------------------------------------

function appIframe(): HTMLIFrameElement {
  const frame = document.getElementById('app');
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('the app frame is not there');
  return frame;
}
const appWindow = (): Window & typeof globalThis => appIframe().contentWindow as Window & typeof globalThis;
export function appDocument(): Document {
  const doc = appIframe().contentDocument;
  if (!doc) throw new Error('the app frame has no document');
  return doc;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** How long to wait between tries, as Playwright does. */
const POLL_MS = [0, 20, 50, 100, 100, 250];

/** Polls until `attempt` returns a value (not undefined), or the time is up (then undefined). */
export async function poll<T>(timeoutMs: number, attempt: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  for (let i = 0; ; i++) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) return undefined;
    await sleep(Math.min(POLL_MS[Math.min(i, POLL_MS.length - 1)], Math.max(0, deadline - performance.now())));
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** An error named as Playwright names it, so the result tells a failed assertion from a broken check. */
export function named(name: 'AssertionError' | 'TimeoutError', text: string): Error {
  const error = new Error(text);
  error.name = name;
  return error;
}
const isFailure = (e: unknown) => e instanceof Error && (e.name === 'AssertionError' || e.name === 'TimeoutError');

// --- locators ----------------------------------------------------------------------------------

// --- the app (a frame) and the page ------------------------------------------------------------

async function navigate(go: () => void, timeout: number, waitUntil?: string): Promise<void> {
  const frame = appIframe();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(named('TimeoutError', `navigation: Timeout ${timeout}ms exceeded`)), timeout);
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    go();
  });
  if (waitUntil === 'networkidle') await sleep(500);
}

export class App extends Locatable {
  private base: string;
  constructor(base: string) {
    super('');
    this.base = base;
  }
  appUrl = (path: string) => new URL(path.replace(/^\/+/, ''), this.base).href;
  url(): string {
    return appWindow().location.href;
  }
  async title(): Promise<string> {
    return appDocument().title;
  }
  async content(): Promise<string> {
    return appDocument().documentElement.outerHTML;
  }
  async goto(url: string, options: { timeout?: number; waitUntil?: string } = {}): Promise<null> {
    const target = new URL(url, this.url()).href;
    await navigate(() => (appIframe().src = target), options.timeout ?? settings.checkTimeoutMs, options.waitUntil);
    return null;
  }
  async reload(options: { timeout?: number; waitUntil?: string } = {}): Promise<null> {
    await navigate(() => appWindow().location.reload(), options.timeout ?? settings.checkTimeoutMs, options.waitUntil);
    return null;
  }
  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? settings.checkTimeoutMs;
    const ok = await poll(timeout, () => {
      try {
        const ready = appDocument().readyState;
        return (state === 'domcontentloaded' ? ready !== 'loading' : ready === 'complete') || undefined;
      } catch {
        return undefined;
      }
    });
    if (!ok) throw named('TimeoutError', `app.waitForLoadState: Timeout ${timeout}ms exceeded`);
    if (state === 'networkidle') await sleep(500);
  }
  async waitForURL(url: Text, options: { timeout?: number } = {}): Promise<void> {
    const timeout = options.timeout ?? settings.checkTimeoutMs;
    const ok = await poll(timeout, () => matchesUrl(this.url(), url, this.base) || undefined);
    if (!ok) throw named('TimeoutError', `app.waitForURL: Timeout ${timeout}ms exceeded waiting for ${String(url)}`);
  }
  async waitForSelector(selector: string, options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}): Promise<void> {
    await this.locator(selector).waitFor(options);
  }
  /** Runs `fn` in the app's window, as Playwright runs it in the page: no closures over the checks' variables. */
  async evaluate<R, A>(fn: string | ((arg: A) => R), arg?: A): Promise<R> {
    const win = appWindow() as unknown as { eval(code: string): unknown };
    if (typeof fn === 'string') return win.eval(fn) as R;
    return (win.eval(`(${fn.toString()})`) as (a: A) => R)(arg as A);
  }
  // Frame shortcuts that take a selector.
  click(selector: string, options?: Parameters<Locator['click']>[0]) {
    return this.locator(selector).click(options);
  }
  fill(selector: string, value: string, options?: Parameters<Locator['fill']>[1]) {
    return this.locator(selector).fill(value, options);
  }
  press(selector: string, key: string, options?: Parameters<Locator['press']>[1]) {
    return this.locator(selector).press(key, options);
  }
  check(selector: string, options?: Parameters<Locator['check']>[0]) {
    return this.locator(selector).check(options);
  }
  textContent(selector: string) {
    return this.locator(selector).textContent();
  }
  isVisible(selector: string) {
    return this.locator(selector).isVisible();
  }
}

export function matchesUrl(actual: string, expected: Text, base: string): boolean {
  return typeof expected === 'string' ? actual === new URL(expected, base).href : expected.test(actual);
}

/** The keyboard, on the element that has focus in the app. */
const keyboard = {
  press: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(keySequence(key)),
  type: (text: string) => userEvent.setup({ document: appDocument() }).keyboard(escapeKeys(text)),
  insertText: async (text: string) => void appDocument().execCommand('insertText', false, text),
  down: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(`{${modifier(key)}>}`),
  up: (key: string) => userEvent.setup({ document: appDocument() }).keyboard(`{/${modifier(key)}}`),
};

/** Anything else a check reaches for is not there: say so by name rather than "is not a function". */
export function guarded<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in t || typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return Reflect.get(t, prop, receiver);
      return () => {
        throw new Error(`${label}.${String(prop)} is not available in checks that run in the page (--checks-in page)`);
      };
    },
  });
}

// --- expect ------------------------------------------------------------------------------------

// --- running a checks file ---------------------------------------------------------------------

async function run(source: string, options: PageChecksOptions): Promise<PageChecksOutput> {
  settings = options;
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
  const app = new App(new URL('.', appWindow().location.href).href);
  const context = {
    app: guarded(app, 'app'),
    page: guarded({ keyboard, waitForTimeout: (ms: number) => sleep(ms), goto: app.goto.bind(app), reload: app.reload.bind(app), url: app.url.bind(app) }, 'page'),
    expect: makeExpect(options.expectTimeoutMs),
    appUrl: app.appUrl,
  };
  const results: PageCheckResult[] = [];
  for (const [name, fn] of Object.entries(checks as Record<string, (ctx: typeof context) => unknown>)) {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => fn(context)),
        new Promise((_, reject) => (timer = setTimeout(() => reject(named('TimeoutError', `check "${name}" timed out`)), options.checkTimeoutMs))),
      ]);
      results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started) });
    } catch (e) {
      results.push({ name, status: isFailure(e) ? 'failed' : 'error', message: message(e), durationMs: Math.round(performance.now() - started) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { results };
}

window.__sandburgPageChecks = { run };
