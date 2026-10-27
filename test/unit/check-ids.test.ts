import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionalCheckIds } from '../../src/check-ids.ts';

test("functional checks' ids are unique: a repeated slug gets -2, -3, …, a name with no a-z or 0-9 its position", () => {
  assert.deepEqual(functionalCheckIds(['Add item', 'add-item', 'ADD ITEM!', 'counts up']), [
    'functional:add-item',
    'functional:add-item-2',
    'functional:add-item-3',
    'functional:counts-up',
  ]);
  assert.deepEqual(functionalCheckIds(['添加', '✓', 'check 2']), ['functional:check-1', 'functional:check-2', 'functional:check-2-2']);
  // A name that is itself a suffixed slug does not take an id given before it.
  assert.deepEqual(functionalCheckIds(['a', 'a', 'a-2']), ['functional:a', 'functional:a-2', 'functional:a-2-2']);
});
