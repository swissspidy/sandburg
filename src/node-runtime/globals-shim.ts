// Injected into the runtime bundle so polyfills (readable-stream, util, …) find
// Node globals at module-evaluation time, before the real process object exists.
// The runtime replaces globalThis.process during init.
import { Buffer } from 'buffer';

const early = {
  env: {} as Record<string, string>,
  version: 'v24.11.0',
  versions: { node: '24.11.0' },
  platform: 'linux',
  argv: [] as string[],
  cwd: () => '/',
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  emitWarning: () => {},
};

export const process = new Proxy(early, {
  get: (t, k) => {
    const real = (globalThis as unknown as { process?: Record<string | symbol, unknown> }).process;
    return real && real !== (process as unknown) ? real[k] : (t as Record<string | symbol, unknown>)[k];
  },
});
export { Buffer };
