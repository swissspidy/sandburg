/**
 * Counts work in flight that a child process's event loop does not see (exitWhenIdle in
 * worker.ts): `fn`'s promise is pending work until it settles. A call that throws instead of
 * returning a promise leaves nothing pending.
 */
export function trackPending<A extends unknown[], R>(pending: { count: number }, fn: (...a: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => {
    pending.count++;
    try {
      return fn(...args).finally(() => pending.count--);
    } catch (e) {
      pending.count--;
      throw e;
    }
  };
}
