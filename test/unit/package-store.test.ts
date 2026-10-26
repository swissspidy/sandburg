import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { link, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './temp-dir.ts';

// The store reads tarballs from npm's cache: this test's own (`npm config get cache` follows it).
const cache = tempDir('sandburg-npm-cache-');
process.env.npm_config_cache = cache;
// unpackAhead's cache index keys name the configured registry; the tests write npmjs.org's.
process.env.npm_config_registry = 'https://registry.npmjs.org/';
const { installFromLockfile, installedPackages, isInstallLocation, normalizeBin, sweepStore, unpackAhead, unpackHint } = await import('../../src/adapters/node/package-store.ts');

/** A ustar archive with npm pack's top directory. */
function tar(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(entries)) {
    const h = Buffer.alloc(512);
    h.write(`package/${path}`, 0);
    h.write('0000644\0', 100);
    const data = Buffer.from(content);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Puts a package's tarball into npm's cache (by content, as cacache does); returns its lock entry. */
async function cached(name: string, version: string, files: Record<string, string>, extra: object = {}): Promise<Record<string, unknown>> {
  const gz = gzipSync(tar({ 'package.json': JSON.stringify({ name, version, ...extra }), ...files }));
  const hex = createHash('sha512').update(gz).digest('hex');
  const at = join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4));
  await mkdir(at, { recursive: true });
  await writeFile(join(at, hex.slice(4)), gz);
  return { version, resolved: `https://registry.test/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: `sha512-${Buffer.from(hex, 'hex').toString('base64')}`, ...extra };
}

async function project(packages: Record<string, unknown>): Promise<string> {
  const dir = tempDir('sandburg-store-');
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'sandburg-install', lockfileVersion: 3, requires: true, packages: { '': { name: 'sandburg-install' }, ...packages } }, null, 2));
  return dir;
}

test('a lockfile installs from the store as npm installs it', async () => {
  const store = tempDir('sandburg-store-root-');
  const packages = {
    'node_modules/tool': await cached('tool', '1.0.0', { 'bin/tool.js': '#!/usr/bin/env node\r\nconsole.log(1);\r\n', 'lib/index.js': 'module.exports = 1;', '.gitignore': 'dist' }, { bin: { tool: './bin/tool.js' } }),
    // Both have an "x" binary: the first by path wins.
    'node_modules/alpha': await cached('alpha', '1.0.0', { 'x.js': 'alpha' }, { bin: { x: 'x.js' } }),
    'node_modules/beta': await cached('beta', '1.0.0', { 'x.js': 'beta' }, { bin: { x: 'x.js' } }),
    // A nested copy links its binary into its own node_modules/.bin.
    'node_modules/beta/node_modules/tool': await cached('tool', '2.0.0', { 'cli.js': '// two' }, { bin: 'cli.js' }),
    // Bundled: inside its parent's tarball.
    'node_modules/gamma': await cached('gamma', '1.0.0', { 'node_modules/inner/package.json': '{"name":"inner","bin":"i.js"}', 'node_modules/inner/i.js': '' }),
    'node_modules/gamma/node_modules/inner': { version: '1.0.0', inBundle: true },
    // --omit=optional leaves it out, and the scope's directory in.
    'node_modules/@native/linux': { version: '1.0.0', resolved: 'https://registry.test/x.tgz', integrity: 'sha512-AAAA', optional: true },
  };
  const dir = await project(packages);
  assert.equal(await installFromLockfile(dir, store, () => {}), true);
  const nm = join(dir, 'node_modules');
  assert.equal(readFileSync(join(nm, 'tool/bin/tool.js'), 'utf8'), '#!/usr/bin/env node\nconsole.log(1);\r\n');
  assert.equal(statSync(join(nm, 'tool/bin/tool.js')).mode & 0o111, 0o111);
  assert.equal(statSync(join(nm, 'tool/lib/index.js')).mode & 0o111, 0);
  assert.equal(readFileSync(join(nm, 'tool/.npmignore'), 'utf8'), 'dist');
  assert.equal(existsSync(join(nm, 'tool/.gitignore')), false);
  assert.equal(readlinkSync(join(nm, '.bin/tool')), '../tool/bin/tool.js');
  assert.equal(readlinkSync(join(nm, '.bin/x')), '../alpha/x.js');
  // A binary is made executable only where it is linked (bin-links), as the tarball has it elsewhere.
  assert.equal(statSync(join(nm, 'alpha/x.js')).mode & 0o111, 0o111);
  assert.equal(statSync(join(nm, 'beta/x.js')).mode & 0o111, 0);
  assert.equal(readlinkSync(join(nm, 'beta/node_modules/.bin/tool')), '../tool/cli.js');
  assert.equal(readlinkSync(join(nm, 'gamma/node_modules/.bin/inner')), '../inner/i.js');
  assert.deepEqual(readdirSync(join(nm, '@native')), []);
  const hidden = JSON.parse(readFileSync(join(nm, '.package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(hidden), ['name', 'lockfileVersion', 'requires', 'packages']);
  assert.deepEqual(Object.keys(hidden.packages), Object.keys(packages).filter((k) => !k.startsWith('node_modules/@native')));
  assert.deepEqual(
    installedPackages(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))).map((p) => p.location),
    Object.keys(packages).filter((k) => !k.startsWith('node_modules/@native')),
  );

  // Another install of the same packages links the store's files.
  const again = await project(packages);
  assert.equal(await installFromLockfile(again, store, () => {}), true);
  assert.equal(lstatSync(join(again, 'node_modules/tool/lib/index.js')).ino, lstatSync(join(nm, 'tool/lib/index.js')).ino);
  // A binary fixBin changed is the install's own copy: the store keeps the tarball's bytes.
  assert.notEqual(lstatSync(join(again, 'node_modules/tool/bin/tool.js')).ino, lstatSync(join(nm, 'tool/bin/tool.js')).ino);
  assert.equal(readFileSync(join(again, 'node_modules/tool/bin/tool.js'), 'utf8'), '#!/usr/bin/env node\nconsole.log(1);\r\n');
  const stored = readdirSync(store).map((n) => join(store, n, 'bin/tool.js')).find((p) => existsSync(p))!;
  assert.equal(readFileSync(stored, 'utf8'), '#!/usr/bin/env node\r\nconsole.log(1);\r\n');
});

test('the store hands what it does not handle back to npm', async () => {
  const store = tempDir('sandburg-store-root-');
  const linked = await project({ 'node_modules/local': { resolved: 'packages/local', link: true }, 'packages/local': { version: '1.0.0' } });
  assert.equal(await installFromLockfile(linked, store, () => {}), false);
  const git = await project({ 'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://git@example.com/g.git#abc' } });
  assert.equal(await installFromLockfile(git, store, () => {}), false);
  // A tarball whose bytes do not match the lockfile's integrity.
  const entry = await cached('bad', '1.0.0', {});
  const other = await cached('other', '1.0.0', { 'a.js': '' });
  const bad = await project({ 'node_modules/bad': { ...entry, integrity: other.integrity }, 'node_modules/ok': entry });
  const hex = Buffer.from(String(other.integrity).slice(7), 'base64').toString('hex');
  await writeFile(join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), gzipSync(tar({ 'package.json': '{"name":"swapped"}' })));
  const lines: string[] = [];
  assert.equal(await installFromLockfile(bad, store, (l) => lines.push(l)), false);
  assert.equal(existsSync(join(bad, 'node_modules')), false);
  assert.match(lines.join('\n'), /integrity mismatch/);
});

test('a lockfile location outside the install\'s node_modules is refused: the store links nothing for it', async () => {
  const store = tempDir('sandburg-store-root-');
  const entry = await cached('escape', '1.0.0', { 'index.js': 'planted' });
  // Beside the project's directory (dir/node_modules/../../<escaped>).
  const escaped = `sandburg-escaped-${process.pid}-${Date.now()}`;
  for (const location of [`node_modules/../../${escaped}`, `node_modules/a/../../../${escaped}`, 'node_modules/./a', 'node_modules//a', 'node_modules/a/', '/node_modules/a', `node_modules/a\\..\\..\\${escaped}`, `node_modules/C:/${escaped}`, 'node_modules/a/node_modules/..', 'node_modules/@s/..', 'node_modules/a/b']) {
    const dir = await project({ 'node_modules/ok': entry, [location]: entry });
    assert.equal(await installFromLockfile(dir, store, () => {}), false, location);
    assert.equal(existsSync(join(dir, 'node_modules')), false, location);
    assert.equal(existsSync(join(dir, '..', escaped)), false, location);
  }
});

test('install locations are a package in node_modules, or nested in one, and nothing else', () => {
  for (const location of ['node_modules/a', 'node_modules/@s/a', 'node_modules/a/node_modules/@s/b', 'node_modules/a.b-c_d', 'node_modules/..a', 'node_modules/@s/a/node_modules/b/node_modules/c']) assert.equal(isInstallLocation(location), true, location);
  for (const location of ['', 'node_modules', 'node_modules/', 'node_modules/..', 'node_modules/.', 'node_modules/../x', 'node_modules/a/..', 'node_modules/@s/../x', 'node_modules/a/b', 'node_modules/a//node_modules/b', 'packages/a', '/abs/node_modules/a', 'node_modules/a\\b', 'node_modules/a\0', 'node_modules/C:x']) assert.equal(isInstallLocation(location), false, location);
});

test('packages are unpacked ahead from a lockfile and from pinned versions in npm\'s cache', async () => {
  const store = tempDir('sandburg-store-root-');
  const fromLock = await cached('locked', '1.0.0', { 'a.js': 'a' });
  const pinned = await cached('pinned', '3.1.4', { 'p.js': 'p' });
  // npm's cache index: the tarball URL's entry names its integrity.
  const key = `make-fetch-happen:request-cache:https://registry.npmjs.org/pinned/-/pinned-3.1.4.tgz`;
  const hash = createHash('sha256').update(key).digest('hex');
  const bucket = join(cache, '_cacache', 'index-v5', hash.slice(0, 2), hash.slice(2, 4));
  await mkdir(bucket, { recursive: true });
  const json = JSON.stringify({ key, integrity: pinned.integrity, time: 0, size: 1, metadata: {} });
  await writeFile(join(bucket, hash.slice(4)), `\n${createHash('sha1').update(json).digest('hex')}\t${json}`);
  const dir = await project({ 'node_modules/locked': fromLock });
  await unpackAhead(dir, { pinned: '3.1.4', ranged: '^1.0.0' }, store);
  const unpacked = readdirSync(store).filter((n) => !n.includes('.tmp-'));
  assert.equal(unpacked.length, 2);
  assert.ok(unpacked.every((n) => existsSync(join(store, n, 'package.json'))));
});

test('packages npm picks are unpacked as it resolves, when their tarball is what its integrity says', async () => {
  const store = tempDir('sandburg-store-root-');
  const good = await cached('picked', '1.0.0', { 'a.js': 'a' });
  const tampered = await cached('tampered', '1.0.0', { 't.js': 't' });
  // The tarball in npm's cache is not the one its integrity names.
  const hex = Buffer.from(String(tampered.integrity).slice(7), 'base64').toString('hex');
  await writeFile(join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), gzipSync(tar({ 'package.json': '{"name":"tampered","version":"1.0.0"}', 't.js': 'evil' })));
  const missing = `sha512-${createHash('sha512').update('not cached').digest('base64')}`;
  for (const integrity of [String(good.integrity), String(tampered.integrity), missing, 'not an integrity']) unpackHint(integrity, store);
  const name = (e: Record<string, unknown>) => `sha512-${Buffer.from(String(e.integrity).slice(7), 'base64').toString('hex')}`;
  for (let i = 0; i < 100 && !existsSync(join(store, name(good), 'a.js')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(join(store, name(good), 'a.js'), 'utf8'), 'a');
  // An install right after takes what is still waiting, and unpacks the tampered one itself: refused.
  const lines: string[] = [];
  const dir = await project({ 'node_modules/picked': good, 'node_modules/tampered': tampered });
  assert.equal(await installFromLockfile(dir, store, (l) => lines.push(l)), false);
  assert.match(lines.join('\n'), /integrity mismatch/);
  assert.ok(!existsSync(join(store, name(tampered))));
  const ok = await project({ 'node_modules/picked': good });
  assert.equal(await installFromLockfile(ok, store, () => {}), true);
  assert.equal(readFileSync(join(ok, 'node_modules', 'picked', 'a.js'), 'utf8'), 'a');
});

test('package binaries are normalized as npm normalizes them', () => {
  assert.deepEqual(normalizeBin({ name: '@scope/tool', bin: './cli.js' }), { tool: 'cli.js' });
  assert.deepEqual(normalizeBin({ name: 'x', bin: { 'a:b': '../../escape.js', '': 'no.js', c: 'bin\\c.js' } }), { b: 'escape.js', c: 'bin/c.js' });
  assert.deepEqual(normalizeBin({ name: 'x' }), {});
});

test('the store sweep removes old packages no install links, and unfinished unpacks', async () => {
  const store = tempDir('sandburg-store-root-');
  const day = new Date(Date.now() - 2 * 24 * 3600_000);
  const make = async (name: string) => {
    await mkdir(join(store, name), { recursive: true });
    await writeFile(join(store, name, 'package.json'), '{}');
    await utimes(join(store, name, 'package.json'), day, day);
    await utimes(join(store, name), day, day);
  };
  await make('sha512-unused');
  await make('sha512-linked');
  await link(join(store, 'sha512-linked', 'package.json'), join(store, 'install-copy.json'));
  await make('sha512-x.tmp-1-abc');
  await mkdir(join(store, 'sha512-new'));
  await writeFile(join(store, 'sha512-new', 'package.json'), '{}');
  await sweepStore(store);
  assert.deepEqual(readdirSync(store).sort(), ['install-copy.json', 'sha512-linked', 'sha512-new']);
});

// The install rules' shims (a WebAssembly build in place of a native binding) replace files of
// packages that come from the store as hard links: written in place, they would change the store's
// copy, and every install linked to it.
test("an install rule's shim replaces a linked file without writing the store's copy", async () => {
  const { replaceFile } = await import('../../src/adapters/node/install.ts');
  const dir = tempDir('sandburg-replace-');
  const stored = join(dir, 'store-index.js');
  const installed = join(dir, 'installed-index.js');
  await writeFile(stored, 'module.exports = require("./binding.node");');
  await link(stored, installed);
  await replaceFile(installed, 'module.exports = require("binding-wasm32-wasi");');
  assert.equal(readFileSync(stored, 'utf8'), 'module.exports = require("./binding.node");');
  assert.equal(readFileSync(installed, 'utf8'), 'module.exports = require("binding-wasm32-wasi");');
  assert.notEqual(statSync(stored).ino, statSync(installed).ino);
  assert.equal(statSync(stored).nlink, 1);
});
