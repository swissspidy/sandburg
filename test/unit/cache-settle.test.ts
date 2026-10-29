import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPOSE_PHASE_MS, MIN_READ_MS, MIN_SEND_MS, READ_TIMEOUT_MAX_MS, readTimeoutMs, SEND_MARGIN_MS, sameFiles, sendTimeoutMs, settledCache, unsettled, type CacheLook } from '../../src/adapters/node/cache-settle.ts';
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
function scripted(lists: (CacheEntry[] | null | 'throw')[] | ((t: number) => CacheEntry[] | null), reads: (CacheEntry[] | 'timeout' | 'throw')[], lookMs = 10) {
  let t = 0;
  let l = 0;
  let r = 0;
  const calls: { bytes: boolean; timeoutMs: number; at: number }[] = [];
  const look: CacheLook<{ files: CacheEntry[]; bytes: boolean }> = async (bytes, timeoutMs) => {
    calls.push({ bytes, timeoutMs, at: t });
    if (!bytes) {
      t += lookMs;
      const files = typeof lists === 'function' ? lists(t) : lists[Math.min(l++, lists.length - 1)];
      if (files === 'throw') throw new TypeError('the worker went away\n    at readCache');
      return files && { files, bytes };
    }
    const read = reads[Math.min(r++, reads.length - 1)];
    if (read === 'throw') throw new Error('the worker went away\n    at readCache');
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

test("a read of a cache's bytes may take longer for a larger cache, up to a limit", () => {
  assert.equal(readTimeoutMs([]), 5000);
  assert.equal(readTimeoutMs([['a', 1, 0]]), 5500);
  assert.equal(readTimeoutMs([['a', 8 << 20, 0], ['b', 1, 0]]), 9500);
  assert.equal(readTimeoutMs([['a', 256 << 20, 0]]), READ_TIMEOUT_MAX_MS);
  const big: CacheEntry[] = [[WAIT[0], 8 << 20, 1], [WAIT[1], 2 << 20, 2]];
  const s = scripted([big], [big]);
  return settledCache(WAIT, s.look, s.clock).then(() => assert.deepEqual(s.calls.filter((c) => c.bytes).map((c) => c.timeoutMs), [10_000]));
});

test('after files changed as they were read, the tree is waited for from what the read saw: a look like it, then a read', async () => {
  const later: CacheEntry[] = [both[0], [WAIT[1], 30, 5]];
  const { look, calls, clock } = scripted([both, both, later], [later, later]);
  const settled = await settledCache(WAIT, look, clock);
  assert.deepEqual(settled.cache?.files, later);
  // Looked at twice (settled), read (changed), looked once (as the read saw it: settled), read.
  assert.deepEqual(calls.map((c) => (c.bytes ? 'read' : 'look')), ['look', 'look', 'read', 'look', 'read']);
});

test('a look or read that throws counts as one that got no answer', async () => {
  const { look, clock } = scripted([both], ['throw', both]);
  assert.deepEqual((await settledCache(WAIT, look, clock)).cache?.files, both);
});

test('a large cache that settles just before the deadline is answered for within the grace: stored or with a reason', async () => {
  const big: CacheEntry[] = [[WAIT[0], 30 << 20, 1], [WAIT[1], 10 << 20, 2]];
  // Missing until 39.6 s, settled at the look ~39.9 s; every read gets no answer (as late as it may).
  const timedOut = scripted((t) => (t < 39_600 ? [big[0]] : big), ['timeout']);
  const late = await settledCache(WAIT, timedOut.look, timedOut.clock);
  assert.match(late.why ?? '', /^after 40 s, (reading its files got no answer|no time was left to read its files)$/);
  assert.ok(timedOut.clock.now() <= 45_000, `answered at ${timedOut.clock.now()} ms`);
  // Its reads are bounded by the time left, and none starts with less than MIN_READ_MS left.
  const reads = timedOut.calls.filter((c) => c.bytes).map((c) => c.timeoutMs);
  assert.ok(reads.length > 0 && reads.every((ms) => ms >= MIN_READ_MS && ms <= 5_250), JSON.stringify(reads));
  // One that answers is stored, also by then.
  const answers = scripted((t) => (t < 39_600 ? [big[0]] : big), [big]);
  assert.deepEqual((await settledCache(WAIT, answers.look, answers.clock)).cache?.files, big);
  assert.ok(answers.clock.now() <= 45_000);
});

test('a read is not started with less than MIN_READ_MS left: the cache says so instead', async () => {
  // A grace of 0.5 s: the cache settles at the look ~39.9 s, with ~0.6 s left.
  const s = scripted((t) => (t < 39_600 ? [both[0]] : both), [both]);
  const settled = await settledCache(WAIT, s.look, { ...s.clock, graceMs: 500 });
  assert.equal(settled.why, 'after 40 s, no time was left to read its files');
  assert.deepEqual(s.calls.filter((c) => c.bytes), []);
});

test('a look started after the deadline is given no more than the time left until the grace ends', async () => {
  // Never settled (a file missing): looks go on until the deadline, the last one starting after it.
  const s = scripted([[both[0]]], [both]);
  await settledCache(WAIT, s.look, s.clock);
  const looks = s.calls.filter((c) => !c.bytes);
  assert.ok(looks.every((c) => c.timeoutMs <= 45_000 - c.at), JSON.stringify(looks.slice(-2)));
  const last = looks.at(-1)!;
  assert.ok(last.at > 40_000 && last.timeoutMs < 5000, JSON.stringify(last));
});

test('a look or read that threw: its error, in one line, with the reason it got no answer', async () => {
  const looks = scripted(['throw'], [both]);
  assert.equal((await settledCache(WAIT, looks.look, looks.clock)).why, 'after 40 s, a look at it got no answer (TypeError: the worker went away)');
  const reads = scripted([both], ['throw']);
  assert.equal((await settledCache(WAIT, reads.look, reads.clock)).why, 'after 40 s, reading its files got no answer (Error: the worker went away)');
  // A look that timed out (no error) says only that.
  const timeouts = scripted([both], ['timeout']);
  assert.equal((await settledCache(WAIT, timeouts.look, timeouts.clock)).why, 'after 40 s, reading its files got no answer');
});

test("an upload of a cache gets what is left of the dispose phase but a margin, or nothing when that is too little", () => {
  assert.equal(sendTimeoutMs(1000, 1000), DISPOSE_PHASE_MS - SEND_MARGIN_MS);
  assert.equal(sendTimeoutMs(1000, 1000 + 45_000), DISPOSE_PHASE_MS - SEND_MARGIN_MS - 45_000);
  assert.equal(sendTimeoutMs(0, DISPOSE_PHASE_MS - SEND_MARGIN_MS - MIN_SEND_MS), MIN_SEND_MS);
  assert.equal(sendTimeoutMs(0, DISPOSE_PHASE_MS - SEND_MARGIN_MS - MIN_SEND_MS + 1), null);
  assert.equal(sendTimeoutMs(0, DISPOSE_PHASE_MS), null);
});
