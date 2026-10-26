import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CompileCache, MAX_CODE } from '../../src/adapters/node/compile-cache.ts';
import { tempDir } from './temp-dir.ts';

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
  const dir = tempDir('sandburg-compile-cache-');
  const key = 'b'.repeat(24);
  const cache = new CompileCache(() => dir);
  assert.equal(await cache.has(key), false);
  assert.equal(await cache.bundle(key), null);
  await cache.record(key, 'cjs', false, '/[eval]', 'module.exports = async function () { await 1; };', 'lowered 1');
  await cache.record(key, 'esm', true, '/app/src/a.mjs', 'export const ü = "é";', 'lowered 2');
  // Large code (asked for by digest) is not kept, and the same code again adds nothing.
  await cache.record(key, 'cjs', false, '/app/.next/chunk.js', 'x'.repeat(MAX_CODE), 'large');
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

test('a stored file that is cut off or not a compile bundle counts as none, and is replaced', async () => {
  const dir = tempDir('sandburg-compile-cache-');
  const key = 'd'.repeat(24);
  const first = new CompileCache(() => dir);
  await first.record(key, 'cjs', false, '/app/a.js', 'module.exports = 1;', 'lowered a');
  await first.flush();
  const [name] = await readdir(dir);
  const whole = await readFile(join(dir, name));
  // Too short for its header length, its header cut off, its last output cut off, a header that is not a list.
  const notJson = Buffer.concat([Buffer.from([4, 0, 0, 0]), Buffer.from('null')]);
  for (const stored of [whole.subarray(0, 2), whole.subarray(0, 12), whole.subarray(0, whole.length - 3), notJson]) {
    await writeFile(join(dir, name), stored);
    const cache = new CompileCache(() => dir);
    assert.equal(await cache.has(key), false);
    assert.equal(await cache.bundle(key), null);
    await cache.record(key, 'cjs', false, '/app/b.js', 'module.exports = 2;', 'lowered b');
    assert.deepEqual(entries((await cache.bundle(key))!), [['cjs', false, '/app/b.js', 'module.exports = 2;', 'lowered b']]);
  }
});
