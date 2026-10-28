import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freemem, totalmem } from 'node:os';
import { availableMemory, parseVmStat } from '../../src/orchestrator/memory.ts';

test('available memory is a positive number of bytes no larger than the machine has', () => {
  const free = availableMemory();
  assert.ok(Number.isFinite(free) && free > 0 && free <= totalmem(), String(free));
});

test('macOS: free and inactive pages from vm_stat, not only the free ones os.freemem() counts', { skip: process.platform !== 'darwin' && 'vm_stat is macOS' }, () => {
  assert.ok(availableMemory() >= freemem() * 0.9, `${availableMemory()} available, ${freemem()} free`);
});

test('vm_stat\'s output is read as free plus inactive pages, in its page size', () => {
  const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5000.
Pages active:                            200000.
Pages inactive:                          150000.
Pages speculative:                         2000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           1000.
"Translation faults":                 123456789.
File-backed pages:                        80000.
`;
  assert.equal(parseVmStat(out), (5000 + 150000) * 16384);
  assert.equal(parseVmStat('Pages free: 12.'), null);
  assert.equal(parseVmStat(''), null);
});
