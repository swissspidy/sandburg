/**
 * What the node adapter keeps of an install in module-level caches (read-ahead listings, preload
 * lists and bundles, seed runs) is not trusted once the install is found removed, as when .sandburg is
 * cleared while the process keeps running (issue #117).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './temp-dir.ts';
import type { Project } from '../../src/types.ts';

// The node adapter serves from the shared installer, rooted here (set before it is loaded).
const root = tempDir('sandburg-forget-');
process.env.SANDBURG_INSTALL_DIR = join(root, '.sandburg', 'installs');
const { serve } = await import('../../src/adapters/node/index.ts');
const { Installer, sharedInstaller } = await import('../../src/adapters/node/install.ts');
const { preloadBundle, preloadUrl, recordLoad } = await import('../../src/adapters/node/preload.ts');
const { nextSeedCache, seedRun } = await import('../../src/adapters/node/seeds.ts');
const { devCacheRoot } = await import('../../src/adapters/node/installs.ts');

const installs = process.env.SANDBURG_INSTALL_DIR;
const installer = sharedInstaller();

// No dependencies: npm resolves an empty tree, without the registry. An override of its own gives
// each its own install key (the key is of what npm installs, not of the project's name).
const project = (name: string) => {
  const packageJson = { name, overrides: { [`unused-${name}`]: '1.0.0' } };
  return { files: { 'package.json': JSON.stringify(packageJson) }, packageJson } as unknown as Project;
};

/**
 * The install of `name`, made by another Installer (another process), with `files` added to it and
 * its index left to be walked again; the shared installer is then asked for it, as a run's install.
 */
async function made(name: string, files: Record<string, string>): Promise<string> {
  const { key, dir } = await new Installer(installs).install(project(name), {}, () => {});
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  rmSync(join(dir, '.sandburg-index.json'));
  await installer.install(project(name), {}, () => {});
  return key;
}

const get = (key: string, rel: string, query = '') =>
  serve({ method: 'GET', path: `/__sandburg/nm/${key}/f/${rel}`, query: new URLSearchParams(query), body: async () => Buffer.alloc(0) });

/** The paths of a bundle (the preload format), and the text of each. */
function bundled(body: string | Uint8Array): [string, string][] {
  const bytes = Buffer.from(body as Uint8Array);
  const length = bytes.readUInt32LE(0);
  let at = 4 + length;
  return (JSON.parse(bytes.subarray(4, 4 + length).toString()) as [string, string, number][]).map(([, rel, size]) => [rel, bytes.subarray(at, (at += size)).toString()]);
}

test("read-ahead: an install removed and made again is listed again, not from this process's listing", async () => {
  const key = await made('listed', { 'node_modules/icons/a.js': 'a', 'node_modules/icons/b.js': 'b', 'node_modules/icons/c.js': 'c' });
  const before = await get(key, 'node_modules/icons/a.js', 'ahead=1');
  assert.deepEqual(bundled(before!.body).map(([rel]) => rel), ['node_modules/icons/a.js', 'node_modules/icons/b.js', 'node_modules/icons/c.js']);
  // .sandburg cleared, and the install made again (with other files) before this process asks for it.
  rmSync(join(root, '.sandburg'), { recursive: true, force: true });
  assert.equal(await made('listed', { 'node_modules/icons/a.js': 'a', 'node_modules/icons/a2.js': 'a2' }), key);
  const after = await get(key, 'node_modules/icons/a.js', 'ahead=1');
  assert.equal(after?.status, 207);
  assert.deepEqual(bundled(after.body), [
    ['node_modules/icons/a.js', 'a'],
    ['node_modules/icons/a2.js', 'a2'],
  ]);
});

test('preload: an install removed and made again gets a bundle of its files, not the one built before', async () => {
  const key = await made('preloaded', { 'node_modules/p/package.json': '{"name":"p","version":"1.0.0"}', 'node_modules/p/data.txt': 'first' });
  // A run loads the file (as serve records it, awaited here).
  await recordLoad(key, 'f', 'node_modules/p/data.txt');
  const url = (await preloadUrl(key, {}))!;
  const [, , hash] = /\/preload\/([0-9a-f]{24})\/([0-9a-f]+)$/.exec(url)!;
  assert.deepEqual(bundled((await preloadBundle(key, hash))!), [['node_modules/p/data.txt', 'first']]);

  rmSync(join(root, '.sandburg'), { recursive: true, force: true });
  assert.equal(await made('preloaded', { 'node_modules/p/package.json': '{"name":"p","version":"1.0.0"}', 'node_modules/p/data.txt': 'second' }), key);
  // A run loads the file (as serve records it, awaited here).
  await recordLoad(key, 'f', 'node_modules/p/data.txt');
  const again = (await preloadUrl(key, {}))!;
  // The same files, so the same URL: its bundle is built again, from the install as it is now.
  assert.equal(again, url);
  assert.deepEqual(bundled((await preloadBundle(key, hash))!), [['node_modules/p/data.txt', 'second']]);
});

test('seeds: a seed whose cache was stored, then removed, runs again; one that stored nothing does not', async () => {
  const versions = { next: '16.0.0', react: '19.0.0', 'react-dom': '19.0.0' };
  const key = (await nextSeedCache(versions, 'app', { seed: true }, () => {}))!.key;
  const runs: string[] = [];
  const options = {
    runSeed: async (seed: Project) => {
      runs.push(seed.name);
      mkdirSync(devCacheRoot(), { recursive: true });
      writeFileSync(join(devCacheRoot(), `${key}.json`), '{}');
    },
  };
  assert.equal((await nextSeedCache(versions, 'app', options, () => {}))?.ready, false);
  await seedRun(key);
  assert.equal(runs.length, 1);
  assert.equal((await nextSeedCache(versions, 'app', options, () => {}))?.ready, true);

  rmSync(join(root, '.sandburg'), { recursive: true, force: true });
  assert.equal((await nextSeedCache(versions, 'app', options, () => {}))?.ready, false);
  await seedRun(key);
  assert.equal(runs.length, 2, 'seeded again');
  assert.equal((await nextSeedCache(versions, 'app', options, () => {}))?.ready, true);

  // A seed run that stores nothing is not run again for every app.
  const other = { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0' };
  const otherKey = (await nextSeedCache(other, 'app', { seed: true }, () => {}))!.key;
  let tries = 0;
  const failing = { runSeed: async () => void tries++ };
  await nextSeedCache(other, 'app', failing, () => {});
  await seedRun(otherKey);
  await nextSeedCache(other, 'app', failing, () => {});
  assert.equal(tries, 1);
});
