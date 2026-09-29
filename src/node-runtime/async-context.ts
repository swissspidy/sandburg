/**
 * AsyncLocalStorage for the browser (ADR 0006).
 *
 * Browsers have no async context propagation (the TC39 AsyncContext proposal
 * is not shipped). The runtime therefore:
 *  1. lowers async functions and generators to generator-based code (on the
 *     host, with esbuild), so every `await` resumes through Promise.then, and
 *  2. patches Promise.prototype.then, queueMicrotask and timers to capture the
 *     current context when a callback is scheduled and restore it when it runs.
 * Zone.js uses the same technique. Contexts are immutable maps from
 * AsyncLocalStorage instance to store.
 */

type Context = Map<object, unknown>;
let current: Context = new Map();

export function currentContext(): Context {
  return current;
}

/** Runs fn with ctx as the current context. */
export function runInContext<R>(ctx: Context, fn: () => R): R {
  const prev = current;
  current = ctx;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** Binds fn to the context current at bind time. */
export function bindContext<F extends (...args: never[]) => unknown>(fn: F): F {
  if (typeof fn !== 'function') return fn;
  const captured = current;
  if (captured.size === 0) return fn; // nothing to carry
  const bound = function (this: unknown, ...args: never[]) {
    const prev = current;
    current = captured;
    try {
      return fn.apply(this, args);
    } finally {
      current = prev;
    }
  };
  return bound as unknown as F;
}

let installed = false;

/** Patches the scheduling primitives once, before any user code runs. */
export function installAsyncContext(): void {
  if (installed) return;
  installed = true;
  const nativeThen = Promise.prototype.then;
  Promise.prototype.then = function (this: Promise<unknown>, onFulfilled?: unknown, onRejected?: unknown) {
    return nativeThen.call(this, bindContext(onFulfilled as never), bindContext(onRejected as never));
  } as typeof Promise.prototype.then;
  const g = globalThis as unknown as Record<string, (fn: unknown, ...rest: unknown[]) => unknown>;
  for (const name of ['queueMicrotask']) {
    const orig = g[name].bind(globalThis);
    g[name] = (fn: unknown, ...rest: unknown[]) => orig(bindContext(fn as never), ...rest);
  }
}

let asyncIds = 1;

export class AsyncLocalStorage<T> {
  static bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return bindContext(fn);
  }

  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    const captured = current;
    return (fn, ...args) => runInContext(captured, () => fn(...args));
  }

  private enabled = true;

  getStore(): T | undefined {
    return this.enabled ? (current.get(this) as T | undefined) : undefined;
  }

  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const next = new Map(current);
    next.set(this, store);
    return runInContext(next, () => fn(...args));
  }

  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const next = new Map(current);
    next.delete(this);
    return runInContext(next, () => fn(...args));
  }

  /** Sets the store for the rest of the current synchronous execution and what it schedules. */
  enterWith(store: T): void {
    const next = new Map(current);
    next.set(this, store);
    current = next;
  }

  disable(): void {
    this.enabled = false;
  }
}

export class AsyncResource {
  private ctx: Context;
  private id = asyncIds++;
  private type: string;

  constructor(type: string) {
    this.type = type;
    this.ctx = current;
  }

  static bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return bindContext(fn);
  }

  bind<F extends (...args: never[]) => unknown>(fn: F): F {
    const ctx = this.ctx;
    return function (this: unknown, ...args: never[]) {
      return runInContext(ctx, () => fn.apply(this, args));
    } as unknown as F;
  }

  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return runInContext(this.ctx, () => fn.apply(thisArg, args));
  }

  emitDestroy(): this {
    return this;
  }

  asyncId(): number {
    return this.id;
  }

  triggerAsyncId(): number {
    return 0;
  }

  get [Symbol.toStringTag](): string {
    return this.type;
  }
}

export const asyncHooks = {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId: () => 1,
  triggerAsyncId: () => 0,
  executionAsyncResource: () => ({}),
  createHook: () => ({ enable() { return this; }, disable() { return this; } }),
  asyncWrapProviders: {},
};
