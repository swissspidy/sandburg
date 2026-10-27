/**
 * A check's AbortSignal on every Playwright call its code makes, so that a check stopped when its
 * time is up stops acting on the app: an action or assertion it was waiting in ends, and one it
 * starts after that fails at once.
 *
 * Playwright takes a signal per call (an action's or an assertion's `signal` option), with no
 * default for a page or a frame. Every call of its client goes through the connection's
 * sendMessageToServer(object, method, params, options), which refuses a call whose options.signal
 * has aborted and asks the driver to abort a call in flight when it aborts. That method is wrapped,
 * once per connection, to add the signal of the code that made the call: withSignal(signal, fn)
 * gives it to fn, and AsyncLocalStorage carries it through fn's awaits and timers.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Page } from 'playwright-core';

type Send = (object: unknown, method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;

const current = new AsyncLocalStorage<AbortSignal>();
const wrapped = new WeakSet<object>();

/** Has the calls of `page`'s connection carry withSignal()'s signal. False if Playwright's client is not as expected (then they do not). */
export function signalCalls(page: Page): boolean {
  const connection = (page as unknown as { _connection?: { sendMessageToServer?: Send } })._connection;
  const send = connection?.sendMessageToServer;
  if (!connection || typeof send !== 'function') return false;
  if (wrapped.has(connection)) return true;
  wrapped.add(connection);
  connection.sendMessageToServer = function (object, method, params, options) {
    const signal = current.getStore();
    // Not on the client's own bookkeeping (__waitInfo__ and the like): it sends those without awaiting them.
    if (signal && !method.startsWith('__')) options = { ...options, signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal };
    return send.call(this, object, method, params, options);
  };
  return true;
}

/** Runs `fn` with the Playwright calls it makes (signalCalls) carrying `signal`. */
export function withSignal<T>(signal: AbortSignal, fn: () => T): T {
  return current.run(signal, fn);
}
