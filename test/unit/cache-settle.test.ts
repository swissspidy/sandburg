import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameFiles, unsettled } from '../../src/adapters/node/cache-settle.ts';
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
