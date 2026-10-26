// For test/unit/flakes.test.ts: a suite whose second subtest fails, a passing suite, and a failing test at the top.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('outer', () => {
  test('passes', () => {});
  describe('inner', () => {
    test('fails', () => assert.fail('nested failure'));
  });
});
describe('fine', () => {
  test('passes too', () => {});
});
test('top fails', () => assert.fail('top failure'));
