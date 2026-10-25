/** The runtime's scripts kept on disk by what they were built from (src/node-runtime/bundle-cache.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { cachedBuild } from '../../src/node-runtime/bundle-cache.ts';

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-bundle-cache-'));
  await mkdir(join(root, 'node_modules/dep'), { recursive: true });
  await writeFile(join(root, 'entry.js'), `import { v } from 'dep'; console.log(v);`);
  await writeFile(join(root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }));
  await writeFile(join(root, 'node_modules/dep/index.js'), `export const v = 1;`);
  let builds = 0;
  const build = () => {
    builds++;
    return esbuild.build({ entryPoints: ['entry.js'], absWorkingDir: root, bundle: true, write: false, metafile: true, format: 'iife', logLevel: 'silent' });
  };
  const dir = join(root, 'cache');
  return { root, dir, builds: () => builds, get: (salt = 's', transform?: (t: string) => string) => cachedBuild('test', salt, root, build, transform, dir) };
}

test('built once, then read back while its inputs are unchanged', async () => {
  const p = await project();
  try {
    const first = await p.get();
    assert.match(first, /v = 1/);
    assert.equal(await p.get(), first);
    assert.equal(p.builds(), 1);
    // The transform's output is what is kept.
    const other = await p.get('t', (t) => `/*x*/${t}`);
    assert.ok(other.startsWith('/*x*/'));
    assert.equal(await p.get('t', () => 'not called'), other);
    assert.equal(p.builds(), 2);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('built again when a file it read, or a package it came from, changes', async () => {
  const p = await project();
  try {
    await p.get();
    await writeFile(join(p.root, 'node_modules/dep/index.js'), `export const v = 2;`);
    assert.match(await p.get(), /v = 2/);
    assert.equal(p.builds(), 2);
    // The package's version changed (its files may resolve differently), its code did not.
    await writeFile(join(p.root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', version: '1.0.1', main: 'index.js' }));
    await p.get();
    assert.equal(p.builds(), 3);
    await writeFile(join(p.root, 'entry.js'), `import { v } from 'dep'; console.log(v + 1);`);
    assert.match(await p.get(), /v \+ 1/);
    assert.equal(p.builds(), 4);
    assert.equal(await p.get(), await p.get());
    assert.equal(p.builds(), 4);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('another salt (the build itself changed) is another entry, which replaces the old; a damaged entry is built again', async () => {
  const p = await project();
  try {
    await p.get('a');
    await p.get('b');
    assert.equal(p.builds(), 2);
    const files = (await readdir(p.dir)).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    await p.get('a');
    assert.equal(p.builds(), 3);
    const [entry] = await readdir(p.dir);
    assert.notEqual(entry, files[0]);
    await writeFile(join(p.dir, entry), '{"inputs":');
    assert.match(await p.get('a'), /v = 1/);
    assert.equal(p.builds(), 4);
    // An entry that lists no inputs is not trusted to be current.
    await writeFile(join(p.dir, entry), JSON.stringify({ inputs: {}, text: 'stale' }));
    assert.match(await p.get('a'), /v = 1/);
    assert.equal(p.builds(), 5);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('a directory it cannot write: built each time, the output as usual', async () => {
  const p = await project();
  try {
    await writeFile(join(p.root, 'blocker'), '');
    const text = await cachedBuild('test', 's', p.root, () => esbuild.build({ entryPoints: ['entry.js'], absWorkingDir: p.root, bundle: true, write: false, metafile: true, logLevel: 'silent' }), undefined, join(p.root, 'blocker', 'cache'));
    assert.match(text, /v = 1/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});
