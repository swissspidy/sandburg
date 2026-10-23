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
    // Written on the side: the hash directory first, then the file under a temporary name, renamed.
    const written = async () => {
      const [sub] = await readdir(dir).catch(() => []);
      const name = sub && (await readdir(join(dir, sub))).find((n) => n.endsWith('.js'));
      return name ? { sub, name } : null;
    };
    let found = await written();
    for (let i = 0; i < 50 && !found; i++) {
      await new Promise((r) => setTimeout(r, 20));
      found = await written();
    }
    assert.ok(found, 'the compile was written');
    const { sub, name } = found;
    const key = sub + name.replace(/\.js$/, '');
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

test('the sweep removes old versions and the oldest compiles beyond the limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-sweep-'));
  try {
    const now = Date.now();
    const day = 24 * 3600_000;
    await mkdir(join(root, 'v1', 'aa'), { recursive: true });
    await mkdir(join(root, 'v2', 'bb'), { recursive: true });
    await mkdir(join(root, 'v3', 'cc'), { recursive: true });
    await utimes(join(root, 'v1'), (now - 2 * day) / 1000, (now - 2 * day) / 1000);
    for (let i = 0; i < 4; i++) {
      const file = join(root, 'v3', 'cc', `${i}.js`);
      await writeFile(file, 'x'.repeat(100));
      await utimes(file, (now - (10 - i) * 1000) / 1000, (now - (10 - i) * 1000) / 1000);
    }
    await sweepCompiles(join(root, 'v3'), 300, now);
    assert.deepEqual((await readdir(root)).sort(), ['v2', 'v3'], 'an old version unchanged for a day goes; a recent one stays');
    assert.deepEqual((await readdir(join(root, 'v3', 'cc'))).sort(), ['2.js', '3.js'], 'the oldest go, down to 3/4 of the limit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
