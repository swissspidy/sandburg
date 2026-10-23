import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompileCache } from '../../src/adapters/node/compile-cache.ts';

/** The bundle's entries, as the runtime reads them (worker.ts loadCompiles). */
function entries(bundle: Buffer): [string, boolean, string, string, string][] {
  const length = bundle.readUInt32LE(0);
  const header = JSON.parse(bundle.subarray(4, 4 + length).toString()) as [string, number, string, number, number][];
  let at = 4 + length;
  return header.map(([kind, async, path, codeLength, outLength]) => {
    const code = bundle.subarray(at, at + codeLength).toString();
    const out = bundle.subarray(at + codeLength, at + codeLength + outLength).toString();
    at += codeLength + outLength;
    return [kind, !!async, path, code, out];
  });
}

test("a project's compiles are kept for its next run, in another process", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-compile-cache-'));
  const key = 'b'.repeat(24);
  const cache = new CompileCache(() => dir);
  assert.equal(await cache.has(key), false);
  assert.equal(await cache.bundle(key), null);
  await cache.record(key, 'cjs', false, '/[eval]', 'module.exports = async function () { await 1; };', 'lowered 1');
  await cache.record(key, 'esm', true, '/app/src/a.mjs', 'export const ü = "é";', 'lowered 2');
  // The same code again adds nothing.
  await cache.record(key, 'cjs', false, '/[eval]', 'module.exports = async function () { await 1; };', 'lowered 1');
  await cache.flush();

  const later = new CompileCache(() => dir);
  assert.equal(await later.has(key), true);
  assert.equal(await later.has('c'.repeat(24)), false);
  assert.deepEqual(entries((await later.bundle(key))!), [
    ['cjs', false, '/[eval]', 'module.exports = async function () { await 1; };', 'lowered 1'],
    ['esm', true, '/app/src/a.mjs', 'export const ü = "é";', 'lowered 2'],
  ]);
});
