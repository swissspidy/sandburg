import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalmem } from 'node:os';
import { availableMemory } from '../../src/orchestrator/memory.ts';

test('available memory is a positive number of bytes no larger than the machine has', () => {
  const free = availableMemory();
  assert.ok(Number.isFinite(free) && free > 0 && free <= totalmem(), String(free));
});
