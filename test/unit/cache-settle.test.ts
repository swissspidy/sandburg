import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTimeoutMs, sameFiles, settledCache, unsettled, type CacheLook } from '../../src/adapters/node/cache-settle.ts';
import type { CacheEntry } from '../../src/node-runtime/cache-tree.ts';

const WAIT = ['.next/dev/cache/webpack/client-development/index.pack.gz', '.next/dev/cache/webpack/server-development/index.pack.gz'];
const both: CacheEntry[] = [
  [WAIT[0], 10, 1],
  [WAIT[1], 20, 2],
];

test('a cache that waits for its files is settled once they are all there, none mid-write, as at the last look', () => {
  assert.equal(unsettled(WAIT, both, both.map((e) => [...e] as CacheEntry)), null);
});

test('a cache that is not settled says why: no answer, a file missing, a pack mid-write, or files still changing', () => {
  assert.equal(unsettled(WAIT, null, both), 'a look at it got no answer');
  assert.equal(unsettled(WAIT, [both[0]], [both[0]]), `no ${WAIT[1]}`);
  assert.equal(unsettled(WAIT, [], []), `no ${WAIT.join(', ')}`);
  const writing: CacheEntry[] = [...both, ['.next/dev/cache/webpack/server-development/0.pack.gz_', 5, 3]];
  assert.equal(unsettled(WAIT, writing, writing), '.next/dev/cache/webpack/server-development/0.pack.gz_ still being written');
  assert.equal(unsettled(WAIT, both, null), 'its files were still changing');
  assert.equal(unsettled(WAIT, both, [both[0], [WAIT[1], 20, 9]]), 'its files were still changing');
  assert.equal(unsettled(WAIT, both, [both[0], [WAIT[1], 21, 2]]), 'its files were still changing');
});

test('two looks found the same files only with the same paths, sizes and mtimes, in order', () => {
  assert.equal(sameFiles(both, both), true);
  assert.equal(sameFiles(both, undefined), false);
  assert.equal(sameFiles(both, [both[1], both[0]]), false);
  assert.equal(sameFiles(both, [both[0]]), false);
});

/**
 * A cache's looks, as scripted: `lists` answers the looks at its files in turn (the last one again
 * after), `reads` the reads of its bytes ('timeout': no answer; else the files the read found). The
 * clock moves only by the waits between looks (`intervalMs`) and each look's own time (`lookMs`).
 */
function scripted(lists: (CacheEntry[] | null)[], reads: (CacheEntry[] | 'timeout')[], lookMs = 10) {
  let t = 0;
  let l = 0;
  let r = 0;
  const calls: { bytes: boolean; timeoutMs: number }[] = [];
  const look: CacheLook<{ files: CacheEntry[]; bytes: boolean }> = async (bytes, timeoutMs) => {
    calls.push({ bytes, timeoutMs });
    if (!bytes) {
      t += lookMs;
      const files = lists[Math.min(l++, lists.length - 1)];
      return files && { files, bytes };
    }
    const read = reads[Math.min(r++, reads.length - 1)];
    t += read === 'timeout' ? timeoutMs : lookMs;
    return read === 'timeout' ? null : { files: read, bytes };
  };
  return { look, calls, clock: { now: () => t, sleep: async (ms: number) => void (t += ms) } };
}

test('a settled cache is read once: its bytes, of the files the looks found', async () => {
  const { look, calls, clock } = scripted([both], [both]);
  const settled = await settledCache(WAIT, look, clock);
  assert.deepEqual(settled.cache?.files, both);
  assert.deepEqual(calls.map((c) => c.bytes), [false, false, true]);
});

test('a read of its bytes that gets no answer is tried again once the cache is settled again, until the deadline', async () => {
  const { look, calls, clock } = scripted([both], ['timeout', both]);
  const settled = await settledCache(WAIT, look, clock);
  assert.equal(settled.why, undefined);
  assert.deepEqual(settled.cache?.files, both);
  assert.equal(calls.filter((c) => c.bytes).length, 2);
});

test('files that changed as their bytes were read are waited for again, then read: the cache is stored', async () => {
  const later: CacheEntry[] = [both[0], [WAIT[1], 30, 5]];
  // Settled (both, both), read finds the server pack written again; then the tree settles on it.
  const { look, calls, clock } = scripted([both, both, later, later], [later, later]);
  const settled = await settledCache(WAIT, look, clock);
  assert.deepEqual(settled.cache?.files, later);
  assert.equal(calls.filter((c) => c.bytes).length, 2);
});

test('a cache that never settles, or whose reads never answer, says why once the deadline passed', async () => {
  const missing = await settledCache(WAIT, scripted([[both[0]]], [both]).look, scripted([[both[0]]], [both]).clock);
  assert.equal(missing.why, `after 40 s, no ${WAIT[1]}`);
  const s = scripted([both], ['timeout']);
  assert.equal((await settledCache(WAIT, s.look, s.clock)).why, 'after 40 s, reading its files got no answer');
  const changing: CacheEntry[] = [both[0], [WAIT[1], 30, 5]];
  const c = scripted([both], [changing]);
  assert.equal((await settledCache(WAIT, c.look, c.clock)).why, 'after 40 s, it changed as its files were read');
});

test("a read of a cache's bytes may take longer for a larger cache", () => {
  assert.equal(readTimeoutMs([]), 5000);
  assert.equal(readTimeoutMs([['a', 1, 0]]), 5500);
  assert.equal(readTimeoutMs([['a', 8 << 20, 0], ['b', 1, 0]]), 9500);
  const big: CacheEntry[] = [[WAIT[0], 8 << 20, 1], [WAIT[1], 2 << 20, 2]];
  const s = scripted([big], [big]);
  return settledCache(WAIT, s.look, s.clock).then(() => assert.deepEqual(s.calls.filter((c) => c.bytes).map((c) => c.timeoutMs), [10_000]));
});
