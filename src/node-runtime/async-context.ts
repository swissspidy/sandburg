import { EventEmitter } from 'events';
import { AWAIT_CONTEXT_GLOBAL } from './names.ts';
/**
 * AsyncLocalStorage for the browser (ADR 0006).
 *
 * Browsers have no async context propagation (the TC39 AsyncContext proposal
 * is not shipped). The runtime therefore:
 *  1. patches Promise.prototype.then, queueMicrotask and timers to capture the
 *     current context when a callback is scheduled and restore it when it runs,
 *  2. has every native `await` restore the context it suspended in (the host
 *     rewrites them: await-context.ts; the calls are `awaitContext` below), and
 *     lowers async generators to generator-based code (their awaits resume
 *     through Promise.then).
 * Zone.js uses the same technique. Contexts are immutable maps from
 * AsyncLocalStorage instance to store.
 */

type Context = Map<object, unknown>;
let current: Context = new Map();

/** Runs fn with ctx as the current context. */
function runInContext<R>(ctx: Context, fn: () => R): R {
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

/** An async function call's state for the awaits rewritten by await-context.ts. */
interface AwaitState {
  /** The function's context, noted as it suspends. */
  c: Context;
  /** The context of the microtask that last resumed it (null until it first resumes). */
  p: Context | null;
  /** Whether it is suspended at an await (a rejected await resumes in a catch or finally block). */
  s: boolean;
}

/** What rewritten awaits call (await-context.ts explains the calls). */
const awaitContext = {
  e: (): AwaitState => ({ c: current, p: null, s: false }),
  s<V>(st: AwaitState, value: V): V {
    // Suspended still: a rejected await resumed into code before a `k` (a lowered function has none;
    // this keeps a stray one from taking the resuming microtask's context for the function's).
    if (st.s) current = st.c;
    st.c = current;
    if (st.p !== null) current = st.p;
    st.s = true;
    return value;
  },
  r<V>(st: AwaitState, value: V): V {
    st.p = current;
    current = st.c;
    st.s = false;
    return value;
  },
  k(st: AwaitState): void {
    if (!st.s) return;
    st.p = current;
    current = st.c;
    st.s = false;
  },
  x(st: AwaitState): void {
    if (!st.s && st.p !== null) current = st.p;
  },
};

let installed = false;

/** Patches the scheduling primitives once, before any user code runs. */
export function installAsyncContext(): void {
  if (installed) return;
  installed = true;
  Object.defineProperty(globalThis, AWAIT_CONTEXT_GLOBAL, { value: Object.freeze(awaitContext), configurable: false, enumerable: false, writable: false });
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

class AsyncLocalStorage<T> {
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

/** An EventEmitter whose listeners run in the async context it was created in (events.EventEmitterAsyncResource). */
export class EventEmitterAsyncResource extends EventEmitter {
  readonly asyncResource: AsyncResource;
  constructor(options?: { name?: string; captureRejections?: boolean }) {
    super(options);
    this.asyncResource = new AsyncResource(options?.name ?? new.target.name);
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.asyncResource.runInAsyncScope(() => super.emit(event, ...args));
  }
  emitDestroy(): void {
    this.asyncResource.emitDestroy();
  }
  get asyncId(): number {
    return this.asyncResource.asyncId();
  }
  get triggerAsyncId(): number {
    return this.asyncResource.triggerAsyncId();
  }
}
