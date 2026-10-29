/**
 * Installs removed while the process keeps running (.sandburg cleared between sessions, issue #117):
 * what the process kept of them is not trusted, and they are installed again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Installer, recordIdentity, sideInstall } from '../../src/adapters/node/install.ts';
import { Resolver } from '../../src/adapters/node/resolver.ts';
import { CompileCache } from '../../src/adapters/node/compile-cache.ts';
import { ESM_MARKER } from '../../src/node-runtime/names.ts';
import type { Project } from '../../src/types.ts';
import { tempDir } from './temp-dir.ts';

// No dependencies: npm resolves an empty tree, without the registry.
const project = (name: string) => ({ files: { 'package.json': JSON.stringify({ name }) }, packageJson: { name } }) as unknown as Project;

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

test('an install removed from disk is installed again, not answered from memory', async () => {
  const installer = new Installer(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('removed'), {}, () => {});
  assert.equal(first.fromCache, false);
  assert.equal((await installer.install(project('removed'), {}, () => {})).dir, first.dir);
  rmSync(first.dir, { recursive: true, force: true });
  const again = await installer.install(project('removed'), {}, () => {});
  assert.equal(again.key, first.key);
  assert.equal(again.fromCache, false);
  assert.ok(existsSync(join(again.dir, '.sandburg-complete')));
  assert.deepEqual(await installer.index(again.key), { 'node_modules/.sandburg-bins.json': 2 });
});

test('a whole store removed (.sandburg cleared): installs are made again in it', async () => {
  const root = tempDir('sandburg-revalidate-');
  const installer = new Installer(join(root, '.sandburg', 'installs'));
  const first = await installer.install(project('cleared'), {}, () => {});
  rmSync(join(root, '.sandburg'), { recursive: true, force: true });
  const again = await installer.install(project('cleared'), {}, () => {});
  assert.equal(again.fromCache, false);
  assert.ok(existsSync(join(first.dir, '.sandburg-complete')));
});

test('only the completion record gone is enough to install again', async () => {
  const installer = new Installer(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('unfinished'), {}, () => {});
  rmSync(join(first.dir, '.sandburg-complete'));
  // The directory without its record is replaced (settle), as one an older version left.
  const again = await installer.install(project('unfinished'), {}, () => {});
  assert.equal(again.fromCache, false);
  assert.ok(existsSync(join(again.dir, '.sandburg-complete')));
});

test("an install removed and made again by another process: this one's transforms, types and index of it are dropped", async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { key, dir } = await new Installer(installs).install(project('remade'), {}, () => {});
  // Files added to the finished install, its index to be walked again: an ES module package.
  write(dir, { 'node_modules/p/package.json': '{"name":"p","type":"module"}', 'node_modules/p/index.js': 'export default "first";' });
  rmSync(join(dir, '.sandburg-index.json'));

  const installer = new Installer(installs);
  const forgotten: string[] = [];
  installer.onForget((k) => forgotten.push(k));
  assert.equal((await installer.install(project('remade'), {}, () => {})).fromCache, true);
  const combined = installer.combine([{ dir: '', key }]);
  const before = (await installer.file(key, 'node_modules/p/index.js'))!.body.toString();
  assert.ok(before.includes('first') && before.startsWith(ESM_MARKER));

  // Another process removes the install and makes it again, now with a CommonJS package.
  rmSync(dir, { recursive: true, force: true });
  await new Installer(installs).install(project('remade'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = "second";' });
  rmSync(join(dir, '.sandburg-index.json'));

  // Its record is another: the install (and the combined key that has it) is forgotten.
  assert.equal((await installer.install(project('remade'), {}, () => {})).fromCache, true);
  assert.deepEqual(forgotten, [key, combined]);
  const after = (await installer.file(key, 'node_modules/p/index.js'))!.body.toString();
  assert.ok(after.includes('second'), after);
  assert.ok(!after.startsWith(ESM_MARKER), 'the package type is read again');
  assert.ok('node_modules/p/index.js' in (await installer.index(key)));
});

test('an install removed and made again here: a transform remembered of a file it no longer has is not served', async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { dir } = await new Installer(installs).install(project('gone-file'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = 1;' });
  rmSync(join(dir, '.sandburg-index.json'));
  const installer = new Installer(installs);
  const { key } = await installer.install(project('gone-file'), {}, () => {});
  assert.ok(await installer.file(key, 'node_modules/p/index.js'));
  assert.ok(installer.remembered(key, 'node_modules/p/index.js'));
  rmSync(dir, { recursive: true, force: true });
  assert.equal((await installer.install(project('gone-file'), {}, () => {})).fromCache, false);
  assert.equal(installer.remembered(key, 'node_modules/p/index.js'), undefined);
  assert.equal(await installer.file(key, 'node_modules/p/index.js'), null);
});

test('installs at once after a removal start one install', async () => {
  const installer = new Installer(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('together'), {}, () => {});
  rmSync(first.dir, { recursive: true, force: true });
  const [a, b] = await Promise.all([installer.install(project('together'), {}, () => {}), installer.install(project('together'), {}, () => {})]);
  assert.equal(a, b);
  assert.equal(a.fromCache, false);
});

test('a side install removed from disk is installed again', async () => {
  const root = tempDir('sandburg-revalidate-');
  const sides = { root: join(root, 'side-installs'), store: join(root, 'store'), resolver: new Resolver(join(root, 'installs'), ['--ignore-scripts']) };
  const manifest = { name: 'sandburg-side-test', private: true, dependencies: {} };
  const dir = await sideInstall(sides, manifest, ['--ignore-scripts'], () => {});
  assert.ok(existsSync(join(dir, '.sandburg-complete')));
  assert.equal(await sideInstall(sides, manifest, ['--ignore-scripts'], () => {}), dir);
  rmSync(sides.root, { recursive: true, force: true });
  assert.equal(await sideInstall(sides, manifest, ['--ignore-scripts'], () => {}), dir);
  assert.ok(existsSync(join(dir, '.sandburg-complete')));
});

test("a project's compiles kept in memory are dropped once their file is removed", async () => {
  const dir = tempDir('sandburg-revalidate-');
  const key = 'f'.repeat(24);
  const cache = new CompileCache(() => dir);
  await cache.record(key, 'cjs', false, '/[eval]', 'module.exports = 1;', 'compiled');
  await cache.flush();
  assert.equal(await cache.has(key), true);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await cache.has(key), false);
  assert.equal(await cache.bundle(key), null);
  // Recorded and not yet written: kept, the file is not there yet.
  await cache.record(key, 'cjs', false, '/[eval]', 'module.exports = 2;', 'compiled 2');
  assert.equal(await cache.has(key), true);
  // Read from a file that is then removed: dropped too.
  await cache.flush();
  const later = new CompileCache(() => dir);
  assert.equal(await later.has(key), true);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(await later.has(key), false);
});

test("a combined key keeps its parts when one is installed again: it is served from the part's new install", async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { key, dir } = await new Installer(installs).install(project('combined'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = "first";' });
  rmSync(join(dir, '.sandburg-index.json'));
  const installer = new Installer(installs);
  await installer.install(project('combined'), {}, () => {});
  // A run of a project with a client/ package holds the combined key.
  const combined = installer.combine([{ dir: 'client', key }]);
  assert.match((await installer.file(combined, 'client/node_modules/p/index.js'))!.body.toString(), /first/);

  rmSync(dir, { recursive: true, force: true });
  await new Installer(installs).install(project('combined'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = "second";', 'node_modules/p/raw.txt': 'raw' });
  rmSync(join(dir, '.sandburg-index.json'));
  await installer.install(project('combined'), {}, () => {});

  assert.match((await installer.file(combined, 'client/node_modules/p/index.js'))!.body.toString(), /second/);
  assert.equal((await installer.raw(combined, 'client/node_modules/p/raw.txt'))?.body.toString(), 'raw');
  assert.ok('client/node_modules/p/raw.txt' in (await installer.index(combined)));
});

test('a record\'s identity keeps file IDs above 2^53 and nanosecond times apart, and works without inode numbers', () => {
  const base = { dev: 2049n, ino: 2n ** 53n, size: 36n, mtimeNs: 1_761_730_000_000_000_001n, birthtimeNs: 1_761_730_000_000_000_001n };
  assert.notEqual(recordIdentity(base), recordIdentity({ ...base, ino: 2n ** 53n + 1n }));
  assert.notEqual(recordIdentity(base), recordIdentity({ ...base, mtimeNs: base.mtimeNs + 1n }));
  // No inode numbers (0 on some file systems): a record made again still differs by its times.
  assert.notEqual(recordIdentity({ ...base, ino: 0n }), recordIdentity({ ...base, ino: 0n, mtimeNs: base.mtimeNs + 1n, birthtimeNs: base.birthtimeNs + 1n }));
  assert.equal(recordIdentity(base), recordIdentity({ ...base }));
});
