/**
 * What the page checks' modules share: the app's frame, the run's settings, polling and the errors
 * they throw, named as Playwright names them.
 */
import { Ivya } from 'ivya';
import type { PageChecksOptions } from './types.ts';
import type { Text } from './locator.ts';

export const ivya = Ivya.create({ browser: 'chromium', testIdAttribute: 'data-testid' });

/** The run's timeouts (run() sets them). */
export const settings: PageChecksOptions = { checkTimeoutMs: 30_000, expectTimeoutMs: 5_000 };

export function appIframe(): HTMLIFrameElement {
  const frame = document.getElementById('app');
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('the app frame is not there');
  return frame;
}

export const appWindow = (): Window & typeof globalThis => appIframe().contentWindow as Window & typeof globalThis;

export function appDocument(): Document {
  const doc = appIframe().contentDocument;
  if (!doc) throw new Error('the app frame has no document');
  return doc;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An error named as Playwright names it, so the result tells a failed assertion from a broken check. */
export function named(name: 'AssertionError' | 'TimeoutError', text: string): Error {
  const error = new Error(text);
  error.name = name;
  return error;
}

export const isFailure = (e: unknown) => e instanceof Error && (e.name === 'AssertionError' || e.name === 'TimeoutError');

export function matchesUrl(actual: string, expected: Text, base: string): boolean {
  return typeof expected === 'string' ? actual === new URL(expected, base).href : expected.test(actual);
}

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
