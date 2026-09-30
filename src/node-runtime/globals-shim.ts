// Injected into the runtime bundle so polyfills (readable-stream, util, …) find
// Node globals at module-evaluation time, before the real process object exists.
// The runtime replaces globalThis.process during init.
import { Buffer } from 'buffer';
import { NODE_VERSION } from './version.ts';

const early = {
  env: {} as Record<string, string>,
  version: `v${NODE_VERSION}`,
  versions: { node: NODE_VERSION },
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
