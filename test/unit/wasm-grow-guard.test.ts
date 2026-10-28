/** Guarding WebAssembly modules with shared memory against lazily seen memory growth (wasm-grow-guard.ts, ADR 0070). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { guardSharedMemoryGrowth } from '../../src/node-runtime/wasm-grow-guard.ts';
import { FILL_ZEROS, leb, moduleWith, repeated } from './wasm-modules.ts';

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
  // Unguarded, V8 traps (in the second round, every time so far). Should a V8 fix it, this fails, so that
  // the test above is known to exercise nothing any more (ADR 0070).
  const traps = [];
  for (const op of [0, 1, 2]) traps.push(await pingPong(PING_PONG, op, 1000));
  assert.ok(
    traps.some((t) => t?.includes('out of bounds')),
    `the unguarded module no longer traps on this V8 (${process.versions.v8}): ${traps.join(', ')}`,
  );
});

/** How many checks a guarded module has (the bytes after each check's operands). */
const checks = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex').split('7c3f00ad42108656').length - 1;

test('ref.as_non_null (0xd4) has no immediate and br_on_null (0xd5) a label: each fill after them is guarded', () => {
  // (param funcref): i32.const 0, i32.const 0, local.get 0, ref.as_non_null, ref.is_null, memory.fill; and a second fill
  const bytes = moduleWith([0x41, 0x00, 0x41, 0x00, 0x20, 0x00, 0xd4, 0xd1, 0xfc, 0x0b, 0x00, ...FILL_ZEROS], { params: [0x70] });
  assert.ok(WebAssembly.validate(bytes));
  const guarded = guardSharedMemoryGrowth(bytes)!;
  assert.ok(WebAssembly.validate(guarded));
  assert.equal(checks(guarded), 2);
  // block, local.get 0, br_on_null 0 (out of the block when null), drop, end, then a fill
  const brOnNull = moduleWith([0x02, 0x40, 0x20, 0x00, 0xd5, 0x00, 0x1a, 0x0b, ...FILL_ZEROS], { params: [0x70] });
  assert.ok(WebAssembly.validate(brOnNull));
  assert.equal(checks(guardSharedMemoryGrowth(brOnNull)!), 1);
});

test('a SIMD opcode past those it knows (FP16 lane operations have immediates), and typed references, leave the module as it is', () => {
  // 0xfd 0x120 (an FP16 operation) before a fill
  assert.equal(guardSharedMemoryGrowth(moduleWith([0xfd, ...leb(0x120), 0x00, ...FILL_ZEROS])), null);
  // a local of (ref null func)
  const typedLocal = moduleWith(FILL_ZEROS, { locals: [[1, 0x63, 0x70]] });
  assert.ok(WebAssembly.validate(typedLocal));
  assert.equal(guardSharedMemoryGrowth(typedLocal), null);
  // a parameter of (ref null func)
  assert.equal(guardSharedMemoryGrowth(moduleWith(FILL_ZEROS, { params: [0x63, 0x70] })), null);
});

test('memory.init is guarded like memory.fill', () => {
  // memory.init of data segment 0: i32.const 0 (dst), i32.const 0 (offset), i32.const 1 (length). The
  // rewrite does not need the segment (the module would, to validate).
  assert.equal(checks(guardSharedMemoryGrowth(moduleWith([0x41, 0x00, 0x41, 0x00, 0x41, 0x01, 0xfc, 0x08, 0x00, 0x00]))!), 1);
});

/** guardSharedMemoryGrowth(bytes) in a thread, given `ms` to answer: 'timeout' if it does not. */
async function guardInThread(bytes: Uint8Array, ms: number): Promise<string> {
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     import(workerData.url).then((m) => parentPort.postMessage(String(m.guardSharedMemoryGrowth(workerData.bytes)?.length ?? null)));`,
    { eval: true, workerData: { bytes, url: new URL('../../src/node-runtime/wasm-grow-guard.ts', import.meta.url).href } },
  );
  try {
    return await new Promise<string>((resolve) => {
      worker.once('message', resolve);
      setTimeout(() => resolve('timeout'), ms);
    });
  } finally {
    await worker.terminate();
  }
}

test('bytes that end inside a count or a number are left as they are, at once', async () => {
  // atomic.fence, then a br_table of 2^32 - 1 labels that are not there
  assert.equal(await guardInThread(moduleWith([0x00, 0xfe, 0x03, 0x00, 0x0e, 0xff, 0xff, 0xff, 0xff, 0x0f]), 10_000), 'null');
  // a number whose bytes all have their continuation bit
  assert.equal(await guardInThread(moduleWith([0xfe, 0x10, 0x82, 0x80, 0x80, 0x80]), 10_000), 'null');
  // a fill, then a body that ends inside local.get's index
  assert.equal(await guardInThread(moduleWith([...FILL_ZEROS, 0x20, 0x80], { end: false }), 10_000), 'null');
});

test('a module the guard would grow by more than half is left as it is', async () => {
  // 100,000 atomic loads in a row (i32.const 0, i32.atomic.load, drop): 7 bytes each, about 30 guarded
  const dense = moduleWith(repeated([0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a], 100_000));
  assert.ok(WebAssembly.validate(dense));
  const started = performance.now();
  assert.equal(guardSharedMemoryGrowth(dense)?.length, undefined);
  assert.ok(performance.now() - started < 2000);
  // A few of them are guarded.
  assert.equal(checks(guardSharedMemoryGrowth(moduleWith([0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a]))!), 1);
});

test('a function body over the limit V8 compiles, or one that alone would grow too much, is left as it is at once', () => {
  const load = [0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a];
  // over 7,654,321 bytes, V8 does not compile it: nops and one fill, which the budget alone would let through
  const nops = moduleWith(new Uint8Array([...FILL_ZEROS, ...repeated([0x01], 7_700_000)]));
  assert.equal(guardSharedMemoryGrowth(nops)?.length, undefined, 'its length when it was guarded');
  const huge = moduleWith(repeated(load, 1_100_000));
  let started = performance.now();
  assert.equal(guardSharedMemoryGrowth(huge)?.length, undefined);
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
  // under it, but growing past the budget well before its end: given up there
  const dense = moduleWith(repeated(load, 1_000_000));
  started = performance.now();
  assert.equal(guardSharedMemoryGrowth(dense)?.length, undefined);
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
});
