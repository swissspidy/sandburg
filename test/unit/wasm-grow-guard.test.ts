/** Guarding WebAssembly modules with shared memory against lazily seen memory growth (wasm-grow-guard.ts, ADR 0070). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { guardSharedMemoryGrowth } from '../../src/node-runtime/wasm-grow-guard.ts';

/**
 * A thread grows a shared memory a page at a time (`writer`) and publishes each new page's address
 * at [0]; `reader` waits for it and then, by `op`, fills it (0), copies to it (1), adds to it
 * atomically (2) or stores to it (3), and counts the round at [4]:
 *
 *   (func (export "writer") (param $n i32) (result i32) ... memory.grow 1, i32.atomic.store [0], wait for [4] ...)
 *   (func (export "reader") (param $n i32) (param $op i32) (result i32)
 *     ... wait for a new address at [0] ...
 *     (if (op == 0) (memory.fill addr 7 16)) (if (op == 1) (memory.copy addr 0 8))
 *     (if (op == 2) (i32.atomic.rmw.add addr 1)) (if (op == 3) (i32.store addr 1)) ...)
 *
 * Unguarded, ops 0-2 trap with "memory access out of bounds" in the second round under Node 24
 * (V8 13.6) and in Chromium; op 3 never does.
 */
const PING_PONG = Buffer.from(
  'AGFzbQEAAAABDAJgAX8Bf2ACf38BfwISAQNlbnYGbWVtb3J5AgMBgIAEAwMCAAEHEwIGd3JpdGVyAAAGcmVhZGVyAAEKxQECRwECfwJAA0AgASAATw0BQQFAAEEQdEHAAGohAiACQcAASA0BQQAgAv4XAgAgAUEBaiEBA0BBBP4QAgAgAUkNAAsMAAsLIAELewEDfwJAA0AgAiAATw0BA0BBAP4QAgAhAyADIARGDQALIAMhBCABRQRAIANBB0EQ/AsACyABQQFGBEAgA0EAQQj8CgAACyABQQJGBEAgA0EB/h4CABoLIAFBA0YEQCADQQE2AgALIAJBAWohAkEEIAL+FwIADAALCyACCw==',
  'base64',
);

/**
 * Bulk memory and atomic operations in functions with parameters and locals of several types (a
 * rewrite that shifted a local or dropped an operand changes what they return):
 *
 *   (func (export "fill") (param $dst i32) (param $v i32) (param $n i32) (result i32) (local i64 f64)
 *     memory.fill, then the last byte filled + the locals)
 *   (func (export "copy") (param $dst i32) (param $src i32) (param $n i32) (result i32) (local i32)
 *     memory.copy, then the local + the first word copied)
 *   (func (export "atomics") (param $a i32) (result i64) (local i64 i32)
 *     i32/i64 atomic store, rmw.add, cmpxchg, xchg, rmw8.add_u, wait32, wait64 (timeout 0),
 *     notify, fence and an i64 atomic load, with offsets 8 and 16, summed)
 */
const OPERATIONS = Buffer.from(
  'AGFzbQEAAAABDQJgA39/fwF/YAF/AX4CEAEDZW52Bm1lbW9yeQIDAQIDBAMAAAEHGQMEZmlsbAAABGNvcHkAAQdhdG9taWNzAAIK7wEDOAIBfgF8QonPlZoSIQNEAAAAAAAABEAhBCAAIAEgAvwLACAAIAJBAWtqLQAAIANCCIinIASqamoLGwEBf0HoByEDIAAgASAC/AoAACADIAAoAgBqC5cBAgF+AX8gAEEF/hcCCCAAQQP+HgIIIQIgAiAAQQhBC/5IAghqIQIgAEKAgICAEP4YAxAgAEIH/kIDECEBIAEgAEIB/iIAEHwhASABIABCCEIJ/kkDEHwhASABIABBAEIA/gECCK18IQEgASAAQglCAP4CAxCtfCEBIAEgAEEB/gACCK18IQH+AwAgASACrXwgAP4RAxB8Cw==',
  'base64',
);

/** The same module with an unshared memory: `(memory 1 2)` instead of `(memory 1 2 shared)`. */
const UNSHARED = (() => {
  const bytes = Buffer.from(OPERATIONS);
  const at = bytes.indexOf(Buffer.from('memory'));
  assert.equal(bytes[at + 7], 0x03);
  bytes[at + 7] = 0x01;
  return bytes;
})();

const instance = (bytes: Uint8Array<ArrayBuffer>) => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  return { memory, exports: new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports as Record<string, (...a: number[]) => number | bigint> };
};

test('a module with shared memory is guarded; it validates, with the same imports and exports', () => {
  for (const bytes of [PING_PONG, OPERATIONS]) {
    const guarded = guardSharedMemoryGrowth(bytes);
    assert.ok(guarded && guarded.length > bytes.length);
    assert.ok(WebAssembly.validate(guarded));
    const [a, b] = [new WebAssembly.Module(bytes), new WebAssembly.Module(guarded)];
    assert.deepEqual(WebAssembly.Module.imports(b), WebAssembly.Module.imports(a));
    assert.deepEqual(WebAssembly.Module.exports(b), WebAssembly.Module.exports(a));
  }
});

test('modules without shared memory, and bytes that are not a module, are left as they are', () => {
  assert.equal(guardSharedMemoryGrowth(UNSHARED), null);
  assert.equal(guardSharedMemoryGrowth(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), null, 'an empty module');
  assert.equal(guardSharedMemoryGrowth(new TextEncoder().encode('not wasm at all')), null);
  assert.equal(guardSharedMemoryGrowth(OPERATIONS.subarray(0, OPERATIONS.length - 9)), null, 'truncated');
  // An instruction it does not know (a GC prefix, 0xfb) where the first function's code begins.
  const unknown = Buffer.from(OPERATIONS);
  const body = unknown.indexOf(Buffer.from([0x02, 0x01, 0x7e, 0x01, 0x7c])) + 5;
  unknown[body] = 0xfb;
  assert.equal(guardSharedMemoryGrowth(unknown), null);
});

test('guarded operations return what the originals do, and an access out of bounds still traps', () => {
  const plain = instance(OPERATIONS);
  const guarded = instance(guardSharedMemoryGrowth(OPERATIONS)!);
  for (const m of [plain, guarded]) new Uint8Array(m.memory.buffer).set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  const calls: [string, number[]][] = [
    ['fill', [100, 9, 5]],
    ['fill', [65530, 255, 6]],
    ['fill', [0, 3, 0x1_0000]],
    ['copy', [200, 0, 8]],
    ['copy', [65532, 4, 4]],
    ['atomics', [256]],
    ['atomics', [65512]],
  ];
  for (const [name, args] of calls) assert.deepEqual(guarded.exports[name](...args), plain.exports[name](...args), `${name}(${args})`);
  assert.deepEqual(new Uint8Array(guarded.memory.buffer), new Uint8Array(plain.memory.buffer));
  for (const [name, args] of [
    ['fill', [65530, 1, 7]],
    ['copy', [65533, 0, 4]],
    ['copy', [0, 65533, 4]],
    ['atomics', [65520]],
  ] as [string, number[]][]) {
    assert.throws(() => plain.exports[name](...args), WebAssembly.RuntimeError, `${name}(${args})`);
    assert.throws(() => guarded.exports[name](...args), { name: 'RuntimeError', message: /out of bounds/ }, `${name}(${args}) guarded`);
  }
});

/** Runs PING_PONG's reader on this thread against a writer thread; the reader's error, if it trapped. */
async function pingPong(bytes: Uint8Array<ArrayBuffer>, op: number, rounds: number): Promise<string | null> {
  const module = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
  const reader = new WebAssembly.Instance(module, { env: { memory } }).exports as { reader(n: number, op: number): number };
  const worker = new Worker(
    `const { workerData: { module, memory }, parentPort } = require('node:worker_threads');
     const writer = new WebAssembly.Instance(module, { env: { memory } });
     parentPort.postMessage('ready');
     writer.exports.writer(${rounds});`,
    { eval: true, workerData: { module, memory } },
  );
  await new Promise((resolve) => worker.once('message', resolve));
  try {
    assert.equal(reader.reader(rounds, op), rounds);
    return null;
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  } finally {
    await worker.terminate();
  }
}

test('a thread that fills, copies to or atomically updates memory another thread just grew does not trap', async () => {
  const guarded = guardSharedMemoryGrowth(PING_PONG)!;
  for (const op of [0, 1, 2, 3]) for (let run = 0; run < 2; run++) assert.equal(await pingPong(guarded, op, 1000), null, `op ${op}`);
});
