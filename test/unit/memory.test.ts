import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { availableMemory, darwinAvailableWith, parseVmStat, VM_STAT } from '../../src/orchestrator/memory.ts';

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

test('macOS: a reading is kept for a second from when vm_stat answered, however long it took', () => {
  let now = 0;
  let calls = 0;
  const read = darwinAvailableWith({
    clock: () => now,
    // Takes 1.5 s, as a loaded machine's might.
    vmStat: () => ((calls += 1), (now += 1500), `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: ${calls}.\nPages inactive: 0.\n`),
  });
  try {
    assert.equal(read(), 4096);
    now += 900;
    assert.equal(read(), 4096, 'kept: 0.9 s after it came back');
    now += 200;
    assert.equal(read(), 2 * 4096, 'read again after a second');
    assert.equal(calls, 2);
  } finally {
    darwinAvailableWith(null);
  }
});
