import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { untar } from '../../src/node-runtime/npm/tar.ts';
import { Registry, type Fetch, type Manifest } from '../../src/node-runtime/npm/registry.ts';
import { resolveTree, UnsupportedSpecError } from '../../src/node-runtime/npm/resolve.ts';
import { installInBrowser, packFiles } from '../../src/node-runtime/npm/install.ts';

/** A tar archive (ustar, one pax long name when a path needs it), as npm pack writes them. */
function tar(entries: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write('0000644\0', 100);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(type, 156);
    h.write('ustar\0', 257);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const [path, content] of Object.entries(entries)) {
    const name = `package/${path}`;
    if (Buffer.byteLength(name) > 100) {
      // pax lengths count bytes, the length's own digits included
      const record = `path=${name}\n`;
      const bytes = Buffer.byteLength(record);
      let length = bytes + 2;
      while (String(length).length + 1 + bytes !== length) length = String(length).length + 1 + bytes;
      const line = Buffer.from(`${length} ${record}`);
      blocks.push(header('PaxHeader', line.length, 'x'), pad(line));
    }
    const data = Buffer.from(content);
    blocks.push(header(name, data.length, '0'), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

test('untar: files without the top directory, long names, no path escapes', () => {
  const long = `lib/${'x'.repeat(120)}.js`;
  const files = untar(tar({ 'package.json': '{}', [long]: 'long', 'index.js': 'module.exports = 1;' }));
  assert.deepEqual(files.map((f) => f.path), ['package.json', long, 'index.js']);
  assert.equal(new TextDecoder().decode(files[2].data), 'module.exports = 1;');
  const odd = untar(tar({ './dist/index.js': 'a', 'lib//x.js': 'b', '../escape.js': 'c' }));
  assert.deepEqual(odd.map((f) => f.path), ['dist/index.js', 'lib/x.js']);
  const unicode = `lib/${'é'.repeat(60)}.js`; // 120 bytes: a pax path whose length counts bytes, not characters
  assert.deepEqual(untar(tar({ [unicode]: 'u' })).map((f) => f.path), [unicode]);
});

/** A registry of a few packages, served from memory. */
function fakeRegistry(packages: Record<string, Record<string, { deps?: Record<string, string>; peer?: Record<string, string>; optional?: Record<string, string>; bin?: Record<string, string>; files?: Record<string, string> }>>, latest: Record<string, string> = {}) {
  const tarballs = new Map<string, Uint8Array>();
  const docs: Record<string, { name: string; 'dist-tags': Record<string, string>; versions: Record<string, Manifest> }> = {};
  for (const [name, versions] of Object.entries(packages)) {
    docs[name] = { name, 'dist-tags': { latest: latest[name] ?? Object.keys(versions).at(-1)! }, versions: {} };
    for (const [version, spec] of Object.entries(versions)) {
      const url = `https://registry.test/${name}/-/${version}.tgz`;
      const gz = new Uint8Array(gzipSync(tar({ 'package.json': JSON.stringify({ name, version }), ...spec.files })));
      tarballs.set(url, gz);
      docs[name].versions[version] = {
        name,
        version,
        dependencies: spec.deps,
        peerDependencies: spec.peer,
        optionalDependencies: spec.optional,
        bin: spec.bin,
        dist: { tarball: url, integrity: `sha512-${createHash('sha512').update(gz).digest('base64')}` },
      };
    }
  }
  const fetchFn: Fetch = async (url) => {
    const name = decodeURIComponent(url.replace('https://registry.test/', ''));
    const body = tarballs.get(url);
    const doc = docs[name];
    const ok = !!(body ?? doc);
    return { ok, status: ok ? 200 : 404, json: async () => doc, arrayBuffer: async () => (body!.buffer as ArrayBuffer).slice(body!.byteOffset, body!.byteOffset + body!.byteLength) };
  };
  return new Registry(fetchFn, 'https://registry.test');
}

test('resolve: latest when it satisfies, shared when a parent has it, nested on conflict', async () => {
  const registry = fakeRegistry(
    {
      a: { '1.0.0': { deps: { c: '^1.0.0' } } },
      b: { '1.0.0': { deps: { c: '^2.0.0' } } },
      c: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {}, '2.1.0': {} },
    },
    { c: '1.5.0' },
  );
  const tree = await resolveTree({ dependencies: { a: '^1', b: '^1', c: '^1.0.0' } }, registry);
  assert.equal(tree.get('node_modules/c')?.version, '1.5.0'); // latest satisfies ^1.0.0
  assert.equal(tree.has('node_modules/a/node_modules/c'), false); // shared
  assert.equal(tree.get('node_modules/b/node_modules/c')?.version, '2.1.0'); // newest ^2, nested
});

test('resolve: peers installed, optional dependencies left out, unsupported specs refused', async () => {
  const registry = fakeRegistry({
    plugin: { '1.0.0': { peer: { host: '^3' }, optional: { native: '^1' } } },
    host: { '3.0.0': {}, '3.2.0': {} },
    native: { '1.0.0': {} },
  });
  const tree = await resolveTree({ dependencies: { plugin: '1.0.0' } }, registry);
  assert.equal(tree.get('node_modules/host')?.version, '3.2.0');
  assert.equal(tree.has('node_modules/native'), false);
  for (const spec of ['github:user/x', 'gitlab:user/x', 'bitbucket:user/x', 'gist:abc123', 'user/x']) {
    await assert.rejects(resolveTree({ dependencies: { x: spec } }, registry), UnsupportedSpecError, spec);
  }
  await assert.rejects(resolveTree({ dependencies: { missing: '^1' } }, registry), /404 Not Found - GET https:\/\/registry\.npmjs\.org\/missing - Not found/);
  await assert.rejects(resolveTree({ dependencies: { host: '^9' } }, registry), /No matching version found for host@\^9/);
});

test('resolve: a v3 lockfile is installed as it is, and says so', async () => {
  const registry = fakeRegistry({ c: { '1.0.0': {}, '1.5.0': {} } });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/c': { version: '1.0.0', optionalDependencies: { 'c-wasm32-wasi': '1.0.0' } }, 'node_modules/opt': { version: '1.0.0', optional: true } } });
  const used = { lockfile: false };
  const tree = await resolveTree({ dependencies: { c: '^1' } }, registry, { lockfile: lock, used });
  assert.deepEqual([...tree.keys()], ['node_modules/c']);
  assert.equal(tree.get('node_modules/c')?.version, '1.0.0');
  // Kept: install.ts finds napi-rs WebAssembly bindings through them.
  assert.deepEqual(tree.get('node_modules/c')?.optionalDependencies, { 'c-wasm32-wasi': '1.0.0' });
  assert.equal(used.lockfile, true);
  // A v1 lockfile is not used: the ranges decide, and the report says the lockfile was not honored.
  await resolveTree({ dependencies: { c: '^1' } }, registry, { lockfile: JSON.stringify({ lockfileVersion: 1, dependencies: {} }), used });
  assert.equal(used.lockfile, false);
});

test('registry: a failure to reach it or read its answer is marked as the registry\'s', async () => {
  const down = new Registry(async () => {
    throw new TypeError('Failed to fetch');
  }, 'https://registry.test');
  await assert.rejects(down.packument('react'), /^Error: npm registry: react: Failed to fetch/);
  const broken = new Registry(async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }), 'https://registry.test');
  await assert.rejects(broken.files({ name: 'x', version: '1.0.0', dist: { tarball: 'https://registry.test/x.tgz' } }), /^Error: npm registry: x@1\.0\.0: /);
});

test('install: files, the binaries index, and one shared block of memory', async () => {
  const registry = fakeRegistry({ tool: { '1.0.0': { bin: { tool: './bin/tool.js' }, files: { 'bin/tool.js': '#!/usr/bin/env node\nconsole.log(1)' } } } });
  const result = await installInBrowser([{ dir: '', packageJson: { devDependencies: { tool: '^1' } }, lockfile: null, extra: {} }], registry, () => {});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.files.get('node_modules/.sandburg-bins.json'))), { tool: 'node_modules/tool/bin/tool.js' });
  assert.equal(result.resolved.tool, '1.0.0');
  const same = new TextEncoder().encode('same');
  const { sab, index } = packFiles(new Map([['a', same], ['b', same], ['c', new TextEncoder().encode('other')]]));
  assert.equal(sab.byteLength, 9); // "same" stored once
  assert.deepEqual(index.a, index.b);
});
