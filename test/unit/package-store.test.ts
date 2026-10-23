import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store reads tarballs from npm's cache: this test's own (`npm config get cache` follows it).
const cache = await mkdtemp(join(tmpdir(), 'sandburg-npm-cache-'));
process.env.npm_config_cache = cache;
const { installFromLockfile, normalizeBin } = await import('../../src/adapters/node/package-store.ts');

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
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-store-'));
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'sandburg-install', lockfileVersion: 3, requires: true, packages: { '': { name: 'sandburg-install' }, ...packages } }, null, 2));
  return dir;
}

test('a lockfile installs from the store as npm installs it', async () => {
  const store = await mkdtemp(join(tmpdir(), 'sandburg-store-root-'));
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
  assert.equal(readlinkSync(join(nm, 'beta/node_modules/.bin/tool')), '../tool/cli.js');
  assert.equal(readlinkSync(join(nm, 'gamma/node_modules/.bin/inner')), '../inner/i.js');
  assert.deepEqual(readdirSync(join(nm, '@native')), []);
  const hidden = JSON.parse(readFileSync(join(nm, '.package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(hidden), ['name', 'lockfileVersion', 'requires', 'packages']);
  assert.deepEqual(Object.keys(hidden.packages), Object.keys(packages).filter((k) => !k.startsWith('node_modules/@native')));

  // Another install of the same packages links the store's files.
  const again = await project(packages);
  assert.equal(await installFromLockfile(again, store, () => {}), true);
  assert.equal(lstatSync(join(again, 'node_modules/tool/lib/index.js')).ino, lstatSync(join(nm, 'tool/lib/index.js')).ino);
});

test('the store hands what it does not handle back to npm', async () => {
  const store = await mkdtemp(join(tmpdir(), 'sandburg-store-root-'));
  const linked = await project({ 'node_modules/local': { resolved: 'packages/local', link: true }, 'packages/local': { version: '1.0.0' } });
  assert.equal(await installFromLockfile(linked, store, () => {}), false);
  const git = await project({ 'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://git@example.com/g.git#abc' } });
  assert.equal(await installFromLockfile(git, store, () => {}), false);
  // A tarball whose bytes do not match the lockfile's integrity.
  const entry = await cached('bad', '1.0.0', {});
  const other = await cached('other', '1.0.0', { 'a.js': '' });
  const bad = await project({ 'node_modules/bad': { ...entry, integrity: other.integrity }, 'node_modules/ok': entry });
  const hex = Buffer.from(String(other.integrity).slice(7), 'base64').toString('hex');
  await writeFile(join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), 'not a tarball');
  const lines: string[] = [];
  assert.equal(await installFromLockfile(bad, store, (l) => lines.push(l)), false);
  assert.equal(existsSync(join(bad, 'node_modules')), false);
  assert.match(lines.join('\n'), /integrity mismatch/);
});

test('package binaries are normalized as npm normalizes them', () => {
  assert.deepEqual(normalizeBin({ name: '@scope/tool', bin: './cli.js' }), { tool: 'cli.js' });
  assert.deepEqual(normalizeBin({ name: 'x', bin: { 'a:b': '../../escape.js', '': 'no.js', c: 'bin\\c.js' } }), { b: 'escape.js', c: 'bin/c.js' });
  assert.deepEqual(normalizeBin({ name: 'x' }), {});
});
