// For test/unit/flakes.test.ts: a suite whose nested subtest fails, a passing suite, a failing test at
// the top, a test that fails itself after a failing subtest, and failing todo tests (not failures).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('outer', () => {
  test('passes', () => {});
  describe('inner', () => {
    test('fails', () => assert.fail('nested failure'));
  });
  test('todo inside', { todo: true }, () => assert.fail('not done'));
});
describe('fine', () => {
  test('passes too', () => {});
});
test('top fails', () => assert.fail('top failure'));
test('own error too', async (t) => {
  await t.test('child fails', () => assert.fail('child failure'));
  throw new Error('parent failure');
});
test('todo at the top', { todo: true }, () => assert.fail('not done'));
