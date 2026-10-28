import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { availableMemory, parseVmStat, VM_STAT } from '../../src/orchestrator/memory.ts';

test('available memory is a positive number of bytes no larger than the machine has', () => {
  const free = availableMemory();
  assert.ok(Number.isFinite(free) && free > 0 && free <= totalmem(), String(free));
});

test("macOS: this machine's vm_stat output is read", { skip: process.platform !== 'darwin' && 'vm_stat is macOS' }, () => {
  // One reading, parsed (two readings, as availableMemory() against os.freemem(), can differ).
  const bytes = parseVmStat(execFileSync(VM_STAT, { encoding: 'utf8' }));
  assert.ok(bytes !== null && bytes > 0 && bytes <= totalmem(), String(bytes));
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
