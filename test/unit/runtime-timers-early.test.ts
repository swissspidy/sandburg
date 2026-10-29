/**
 * The runtime's timers (src/node-runtime/builtins/process.ts) with a browser whose timers fire early by
 * performance.now() (5 ms here): a timer still runs at its time, not before (its browser timer is set
 * again for the rest), and it runs (ADR 0069).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const realSetTimeout = globalThis.setTimeout;
test('a timer whose browser timer fires before its time runs at its time, not before', async () => {
  // The browser's setTimeout, as process.ts takes it when it loads: 5 ms early.
  globalThis.setTimeout = ((fn: () => void, ms: number) => realSetTimeout(fn, Math.max(0, ms - 5))) as typeof setTimeout;
  try {
    const { timers } = await import('../../src/node-runtime/builtins/process.ts');
    for (const ms of [20, 50]) {
      const set = performance.now();
      const waited = await new Promise<number>((done) => timers.setTimeout(() => done(performance.now() - set), ms));
      assert.ok(waited >= ms - 1, `a ${ms} ms timer ran after ${waited.toFixed(1)} ms`);
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
