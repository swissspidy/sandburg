/** How long the checks wait for the app to settle (src/host/settle.ts' settle): the framework's word, else quiet servers, within a time limit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../../src/host/settle.ts';
import type { Activity } from '../../src/host/types.ts';

const busy: Activity = { inflight: 1, idleMs: 0, sinceRequestMs: 0, newestInflightMs: 0 };
const quietNow: Activity = { inflight: 0, idleMs: 500, sinceRequestMs: 500, newestInflightMs: null };

/** settle() on a clock that only moves when it sleeps: its answer, and how long it waited. */
async function waited(safe: () => boolean | undefined, activity: () => Activity | null = () => busy): Promise<{ settled: boolean | null; ms: number }> {
  let clock = 0;
  const settled = await settle({ activity, safe, quietMs: 100, longMs: 1_000, maxMs: 3_000, hydrateMaxMs: 10_000, pollMs: 20, now: () => clock, sleep: async (ms) => (clock += ms) });
  return { settled, ms: clock };
}

test('a framework that says it has not hydrated is waited for up to hydrateMaxMs; one that says nothing, up to maxMs', async () => {
  assert.deepEqual(await waited(() => false), { settled: false, ms: 10_000 });
  // Saying nothing, with servers that stay busy: the 3 s limit, as before.
  assert.deepEqual(await waited(() => undefined), { settled: false, ms: 3_000 });
  // Saying nothing, with quiet servers: at once.
  assert.deepEqual(await waited(() => undefined, () => quietNow), { settled: true, ms: 0 });
});

test("the framework's word decides over the servers: not yet while they are quiet, and done when it says so", async () => {
  let calls = 0;
  // Hydrated after 5 s: past the 3 s limit, within the 10 s one.
  assert.deepEqual(await waited(() => ++calls * 20 >= 5_000 || false, () => quietNow), { settled: true, ms: 4_980 });
  assert.deepEqual(await waited(() => true), { settled: true, ms: 0 });
});

test('without a runtime that reports its activity: null', async () => {
  assert.deepEqual(await waited(() => true, () => null), { settled: null, ms: 0 });
});
