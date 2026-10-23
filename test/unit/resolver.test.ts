import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackumentCache } from '../../src/adapters/node/resolver.ts';

test('the resolver keeps packuments by their size, least recently used out first', () => {
  const cache = new PackumentCache(100);
  cache.set('a', { _contentLength: 40 });
  cache.set('b', { _contentLength: 40 });
  assert.ok(cache.get('a')); // a is now the most recently used
  cache.set('c', { _contentLength: 40 });
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  // Without a length it cannot be counted, and over half the budget it would push out the rest.
  cache.set('d', {});
  cache.set('e', { _contentLength: 60 });
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  cache.delete('a');
  cache.set('f', { _contentLength: 50 });
  assert.deepEqual([...cache.keys()], ['c', 'f']);
});
