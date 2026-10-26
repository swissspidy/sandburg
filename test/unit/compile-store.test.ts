import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compiled, compileForRuntime, storeCompiles } from '../../src/adapters/node/compile.ts';
import { diskCompileStore, sweepCompiles } from '../../src/adapters/node/compile-store.ts';

test('compiles are stored on disk and found by a later process (by the same key)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-compiled-'));
  try {
    const dir = join(root, 'v1');
    storeCompiles(diskCompileStore(dir));
    const out = compileForRuntime(`export const stored = ${Date.now()};`, '/app/src/stored.mjs', 'esm');
    // Written on the side: wait for the file under its final name.
    const files = await until(() => storedFiles(dir), (f) => f.length > 0);
    assert.equal(files.length, 1);
    const key = files[0].replace('/', '').replace(/\.js$/, '');
    assert.equal(diskCompileStore(dir).read(key), out);
    // What another process's store holds is found by its key (the digest route asks for it).
    const other = 'f'.repeat(64);
    await mkdir(join(dir, 'ff'), { recursive: true });
    await writeFile(join(dir, 'ff', `${other.slice(2)}.js`), 'compiled before');
    assert.equal(compiled(other), 'compiled before');
    assert.equal(compiled('e'.repeat(64)), undefined);
  } finally {
    storeCompiles({ read: () => undefined, write: () => {} });
    await rm(root, { recursive: true, force: true });
  }
});

test('a process that writes a quarter of the limit sweeps again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-compiled-'));
  try {
    const dir = join(root, 'v1');
    const store = diskCompileStore(dir, 400);
    // 150 bytes each: a sweep after every second write (a quarter of 400), down to 300 bytes.
    for (let i = 0; i < 6; i++) await store.write(`${i}`.padStart(64, 'a'), 'x'.repeat(150));
    const left = await storedFiles(dir);
    assert.ok(left.length * 150 <= 400, left.join(', '));
    assert.ok(left.some((f) => f.endsWith('5.js')), 'the newest stays');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the sweep removes old versions and the oldest compiles beyond the limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-sweep-'));
  try {
    const now = Date.now();
    const day = 24 * 3600_000;
    await mkdir(join(root, 'v1', 'aa'), { recursive: true });
    await mkdir(join(root, 'v2', 'bb'), { recursive: true });
    await mkdir(join(root, 'v3', 'cc'), { recursive: true });
    // Named with the compiler's digest too (adapters/node/index.ts), old and recent.
    await mkdir(join(root, 'v3-0a1b2c3d4e5f', 'dd'), { recursive: true });
    await mkdir(join(root, 'v3-abcdef012345', 'ee'), { recursive: true });
    await utimes(join(root, 'v1'), (now - 2 * day) / 1000, (now - 2 * day) / 1000);
    await utimes(join(root, 'v3-0a1b2c3d4e5f'), (now - 2 * day) / 1000, (now - 2 * day) / 1000);
    for (let i = 0; i < 4; i++) {
      const file = join(root, 'v3', 'cc', `${i}.js`);
      await writeFile(file, 'x'.repeat(100));
      await utimes(file, (now - (10 - i) * 1000) / 1000, (now - (10 - i) * 1000) / 1000);
    }
    await sweepCompiles(join(root, 'v3'), 300, now);
    assert.deepEqual((await readdir(root)).sort(), ['v2', 'v3', 'v3-abcdef012345'], 'an old version unchanged for a day goes; a recent one stays');
    assert.deepEqual((await readdir(join(root, 'v3', 'cc'))).sort(), ['2.js', '3.js'], 'the oldest go, down to 3/4 of the limit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The finished compiles under `dir` ("ab/cdef….js"), not files still being written. */
async function storedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of await readdir(dir).catch(() => [] as string[])) {
    for (const name of await readdir(join(dir, sub)).catch(() => [] as string[])) if (name.endsWith('.js')) out.push(`${sub}/${name}`);
  }
  return out;
}

/** `get()` once `done` holds for its value, polling for up to 2 s. */
async function until<T>(get: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await get();
  for (let i = 0; i < 100 && !done(v); i++) {
    await new Promise((r) => setTimeout(r, 20));
    v = await get();
  }
  return v;
}
