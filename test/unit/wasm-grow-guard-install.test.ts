/**
 * The growth guard installed (installWasmGrowGuard, wasm-grow-guard.ts; ADR 0070): WebAssembly's own
 * behaviour stays, for every module. Expected values are Node 24's, from the native API, taken
 * before the guard is installed in this process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardSharedMemoryGrowth, installWasmGrowGuard } from '../../src/node-runtime/wasm-grow-guard.ts';
import { trackPending } from '../../src/node-runtime/track-pending.ts';
import { FILL_ZEROS, moduleWith } from './wasm-modules.ts';

const native = { Module: WebAssembly.Module, compile: WebAssembly.compile.bind(WebAssembly), instantiate: WebAssembly.instantiate.bind(WebAssembly) };
installWasmGrowGuard();

/** `(import "wasm:js-string" "length" (func (param externref) (result i32)))`, exported as `len`. */
const JS_STRING = Buffer.from('AGFzbQEAAAABBgFgAW8BfwIZAQ53YXNtOmpzLXN0cmluZwZsZW5ndGgAAAMCAQAHBwEDbGVuAAEKCAEGACAAEAAL', 'base64');

const detached = () => {
  const buffer = new ArrayBuffer(8);
  structuredClone(buffer, { transfer: [buffer] });
  return buffer;
};
const failure = (e: unknown): string[] => [(e as Error).constructor.name, (e as Error).message];

test('compile options (builtins) reach WebAssembly, for new Module, compile and instantiate', async () => {
  const options = { builtins: ['js-string'] };
  const expected = new native.Module(JS_STRING, options);
  assert.deepEqual(WebAssembly.Module.imports(expected), []);
  const module = new WebAssembly.Module(JS_STRING, options);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal((new WebAssembly.Instance(module).exports.len as (s: string) => number)('abc'), 3);
  const compiled = await (WebAssembly.compile as (b: BufferSource, o: unknown) => Promise<WebAssembly.Module>)(JS_STRING, options);
  assert.deepEqual(WebAssembly.Module.imports(compiled), []);
  const { instance } = (await (WebAssembly.instantiate as (b: BufferSource, i: unknown, o: unknown) => Promise<WebAssembly.WebAssemblyInstantiatedSource>)(JS_STRING, {}, options));
  assert.equal((instance.exports.len as (s: string) => number)('abcd'), 4);
});

test('a detached buffer: new Module throws a CompileError, compile and instantiate return a rejected promise', async () => {
  const expected = (() => {
    try {
      new native.Module(detached());
    } catch (e) {
      return failure(e);
    }
  })();
  assert.equal(expected?.[0], 'CompileError');
  assert.throws(() => new WebAssembly.Module(detached()), (e) => assert.deepEqual(failure(e), expected) ?? true);
  for (const [name, call] of [
    ['compile', () => WebAssembly.compile(detached())],
    ['instantiate', () => WebAssembly.instantiate(detached())],
  ] as const) {
    let promise: Promise<unknown> | undefined;
    assert.doesNotThrow(() => (promise = call()), name);
    const nativeError = await (name === 'compile' ? native.compile(detached()) : native.instantiate(detached())).catch(failure);
    assert.deepEqual(await promise!.catch(failure), nativeError, name);
  }
});

test("an invalid module's error is WebAssembly's for the bytes as given, though the caller changes them right after", async () => {
  // A fill, then an i64 the function (no results) does not drop: guarded, and invalid.
  const bytes = moduleWith([...FILL_ZEROS, 0x42, 0x00]);
  assert.ok(guardSharedMemoryGrowth(bytes), 'the rewrite guards it');
  const expected = await native.compile(bytes.slice()).then(() => [], failure);
  assert.equal(expected[0], 'CompileError');
  for (const name of ['compile', 'instantiate'] as const) {
    const given = bytes.slice();
    const promise = name === 'compile' ? WebAssembly.compile(given) : WebAssembly.instantiate(given);
    given.fill(0);
    const got = await promise.then(() => [], failure);
    assert.deepEqual(got, [expected[0], expected[1].replace('WebAssembly.compile()', `WebAssembly.${name}()`)], name);
  }
  assert.throws(() => new WebAssembly.Module(bytes), (e) => assert.deepEqual(failure(e)[0], 'CompileError') ?? true);
});

test('work counted as pending stops counting when the call throws instead of returning a promise', async () => {
  const pending = { count: 0 };
  const settles = trackPending(pending, (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const throws = trackPending(pending, (): Promise<void> => {
    throw new TypeError('no promise');
  });
  const p = settles(5);
  assert.equal(pending.count, 1);
  assert.throws(() => throws(), TypeError);
  assert.equal(pending.count, 1);
  await p;
  assert.equal(pending.count, 0);
});
