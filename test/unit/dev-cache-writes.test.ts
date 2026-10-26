/**
 * Writes of dev-server caches (ADR 0033, 0037): a write needs the token issued to that run, from that
 * run's own sandbox, once. A cache key is a digest of public inputs (a seed's versions), so it never
 * grants a write by itself.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRequest, HostResponse } from '../../src/types.ts';

let root: string;
let node: typeof import('../../src/adapters/node/index.ts');
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandburg-dev-cache-'));
  process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
  node = await import('../../src/adapters/node/index.ts');
});
after(() => rm(root, { recursive: true, force: true }));

const DIRS = ['.next/dev/cache'];
const cacheFile = (key: string) => join(root, 'dev-cache', `${key}.json`);

function post(key: string, sandbox: string, token: string | undefined, files: Record<string, string>): Promise<HostResponse | null> {
  const req: HostRequest = {
    method: 'POST',
    path: `/__sandburg/dev-cache/${key}`,
    query: new URLSearchParams(),
    sandbox,
    headers: token === undefined ? {} : { 'x-sandburg-token': token },
    body: async () => Buffer.from(JSON.stringify(files)),
  };
  return node.serve(req);
}

test('a seed key takes the seed run\'s write only: not an app beside it with the key, nor another sandbox with the token', async () => {
  const seedKey = 'a'.repeat(24);
  const appKey = 'b'.repeat(24);
  // The seed run (sandbox s-seed) and the first app with those versions (s-app) run side by side;
  // the app knows the seed's key (a digest of public versions) and has a token of its own.
  const seedToken = node.issueCacheWrite(seedKey, DIRS, Promise.resolve('s-seed'));
  const appToken = node.issueCacheWrite(appKey, DIRS, Promise.resolve('s-app'));
  await new Promise((r) => setImmediate(r));
  const planted = { '.next/dev/cache/webpack/client-development/index.pack.gz': 'planted' };

  // The app's page posts under the seed's key first: without a token, with its own, with a guessed one.
  assert.equal((await post(seedKey, 's-app', undefined, planted))?.status, 403);
  assert.equal((await post(seedKey, 's-app', appToken, planted))?.status, 403);
  assert.equal((await post(seedKey, 's-app', 'A'.repeat(43), planted))?.status, 403);
  // With the seed run's own token (had it leaked) but from another sandbox's origin.
  assert.equal((await post(seedKey, 's-app', seedToken, planted))?.status, 403);
  await assert.rejects(readFile(cacheFile(seedKey)));

  // The seed run's own write lands.
  const seed = { '.next/dev/cache/webpack/client-development/index.pack.gz': 'the seed' };
  assert.equal((await post(seedKey, 's-seed', seedToken, seed))?.status, 200);
  assert.deepEqual(JSON.parse(await readFile(cacheFile(seedKey), 'utf8')), seed);
  // Replayed, from its own sandbox: the token took one write.
  assert.equal((await post(seedKey, 's-seed', seedToken, planted))?.status, 403);
  assert.deepEqual(JSON.parse(await readFile(cacheFile(seedKey), 'utf8')), seed);

  // The app's own cache: its token, from its sandbox, once.
  const own = { '.next/dev/cache/own': 'own' };
  assert.equal((await post(appKey, 's-seed', appToken, own))?.status, 403);
  assert.equal((await post(appKey, 's-app', appToken, own))?.status, 200);
  assert.equal((await post(appKey, 's-app', appToken, own))?.status, 403);
});

test('a token is not usable before its run\'s sandbox is known, and a failed write keeps it', async () => {
  const key = 'c'.repeat(24);
  let bind: (id: string) => void = () => {};
  const token = node.issueCacheWrite(key, DIRS, new Promise<string>((r) => (bind = r)));
  assert.equal((await post(key, 's-x', token, { '.next/dev/cache/a': 'a' }))?.status, 403);
  bind('s-x');
  await new Promise((r) => setImmediate(r));
  const broken = await node.serve({ method: 'POST', path: `/__sandburg/dev-cache/${key}`, query: new URLSearchParams(), sandbox: 's-x', headers: { 'x-sandburg-token': token }, body: async () => Buffer.from('{not json') });
  assert.equal(broken?.status, 403);
  assert.equal((await post(key, 's-x', token, { '.next/dev/cache/a': 'a' }))?.status, 200);
});

test('compiles are recorded under a project\'s key only with its run\'s token, from its sandbox', async () => {
  const key = 'd'.repeat(24);
  const token = node.issueCompileWrite(key, Promise.resolve('s-own'));
  await new Promise((r) => setImmediate(r));
  const compile = (sandbox: string, t: string | undefined, path: string) =>
    node.serve({ method: 'POST', path: '/__sandburg/compile', query: new URLSearchParams({ kind: 'cjs', path, cache: key }), sandbox, headers: t ? { 'x-sandburg-token': t } : {}, body: async () => Buffer.from(`module.exports = ${JSON.stringify(path)};`) });
  const recorded = async () => {
    const res = await node.serve({ method: 'GET', path: `/__sandburg/compile-cache/${key}`, query: new URLSearchParams(), sandbox: 's-own', body: async () => Buffer.alloc(0) });
    if (!res) return [] as string[];
    const bundle = Buffer.from(res.body as Uint8Array);
    return (JSON.parse(bundle.subarray(4, 4 + bundle.readUInt32LE(0)).toString('utf8')) as [string, number, string][]).map((e) => e[2]);
  };
  // Compiled for everyone, recorded for none of these.
  assert.equal((await compile('s-other', undefined, '/no-token.js'))?.status, 200);
  assert.equal((await compile('s-other', token, '/other-sandbox.js'))?.status, 200);
  assert.equal((await compile('s-own', 'A'.repeat(43), '/guessed.js'))?.status, 200);
  assert.equal((await compile('s-own', token, '/own.js'))?.status, 200);
  let paths: string[] = [];
  for (let i = 0; i < 50 && !paths.length; i++) {
    await new Promise((r) => setTimeout(r, 20));
    paths = await recorded();
  }
  assert.deepEqual(paths, ['/own.js']);
});

/** A cache as the page sends it (node-runtime/cache-tree.ts): u32 header length, JSON header, bytes. */
function bundle(files: [string, Uint8Array | string][], tamper?: (header: [string, string, number][]) => void): Buffer {
  const bodies = files.map(([, b]) => Buffer.from(b));
  const entries = files.map(([path], i) => ['f', path, bodies[i].length] as [string, string, number]);
  tamper?.(entries);
  const header = Buffer.from(JSON.stringify(entries));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  return Buffer.concat([length, header, ...bodies]);
}

function postBundle(key: string, sandbox: string, token: string, body: Buffer): Promise<HostResponse | null> {
  return node.serve({ method: 'POST', path: `/__sandburg/dev-cache/${key}`, query: new URLSearchParams(), sandbox, headers: { 'x-sandburg-token': token, 'content-type': 'application/octet-stream' }, body: async () => body });
}

test('a cache sent as a bundle is stored as text and base64, only under its directories', async () => {
  const key = 'd'.repeat(24);
  const token = node.issueCacheWrite(key, DIRS, Promise.resolve('s-bin'));
  await new Promise((r) => setImmediate(r));
  const pack = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00]);
  const body = bundle([
    ['.next/dev/cache/webpack/client-development/0.pack.gz', pack],
    ['.next/dev/cache/webpack/client-development/index.pack.gz.old', '﻿text with a BOM'],
    ['.next/dev/cache/../../../package.json', 'escaped'],
    ['src/app/page.tsx', 'not a cache file'],
  ]);
  // From another sandbox, with this run's token: refused, as a JSON write is.
  assert.equal((await postBundle(key, 's-other', token, body))?.status, 403);
  assert.equal((await postBundle(key, 's-bin', token, body))?.status, 200);
  assert.deepEqual(JSON.parse(await readFile(cacheFile(key), 'utf8')), {
    '.next/dev/cache/webpack/client-development/0.pack.gz': { base64: Buffer.from(pack).toString('base64') },
    '.next/dev/cache/webpack/client-development/index.pack.gz.old': '﻿text with a BOM',
  });
});

test('a malformed bundle is refused, nothing is stored, and the token is kept', async () => {
  const key = 'e'.repeat(24);
  const token = node.issueCacheWrite(key, DIRS, Promise.resolve('s-bad'));
  await new Promise((r) => setImmediate(r));
  const good = bundle([['.next/dev/cache/a', 'a']]);
  const huge = Buffer.from(good);
  huge.writeUInt32LE(0xffffffff);
  const malformed = [
    Buffer.alloc(2),
    huge,
    // Lengths that do not add up to the body: longer, shorter, negative, not integers.
    bundle([['.next/dev/cache/a', 'a']], (h) => (h[0][2] = 5)),
    Buffer.concat([good, Buffer.from('trailing')]),
    bundle([['.next/dev/cache/a', 'a']], (h) => (h[0][2] = -1)),
    bundle([['.next/dev/cache/a', 'a']], (h) => (h[0][2] = 0.5)),
    // A header that is not a list of files.
    bundle([['.next/dev/cache/a', 'a']], (h) => ((h[0] as unknown as unknown[])[1] = 7)),
    Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from('{}')]),
  ];
  for (const body of malformed) assert.equal((await postBundle(key, 's-bad', token, body))?.status, 403);
  await assert.rejects(readFile(cacheFile(key)));
  assert.equal((await postBundle(key, 's-bad', token, good))?.status, 200);
  assert.deepEqual(JSON.parse(await readFile(cacheFile(key), 'utf8')), { '.next/dev/cache/a': 'a' });
});

test('bundledEntries reads what bundleCache writes', async () => {
  const { bundleCache, listCache } = await import('../../src/node-runtime/cache-tree.ts');
  const { Vfs } = await import('../../src/node-runtime/vfs.ts');
  const vfs = new Vfs(() => new Uint8Array());
  vfs.mkdir('/app/.next/dev/cache/webpack', true);
  vfs.write('/app/.next/dev/cache/webpack/index.pack.gz', Uint8Array.from([0x1f, 0x8b, 0xff]));
  vfs.write('/app/.next/dev/cache/webpack/x.json', new TextEncoder().encode('{"a":1}'));
  const files = listCache(vfs, '/app', ['.next/dev/cache', 'node_modules/.vite']);
  assert.deepEqual(files.map(([path, size]) => [path, size]), [['.next/dev/cache/webpack/index.pack.gz', 3], ['.next/dev/cache/webpack/x.json', 7]]);
  assert.deepEqual(node.bundledEntries(Buffer.from(bundleCache(vfs, '/app', files))), {
    '.next/dev/cache/webpack/index.pack.gz': { base64: Buffer.from([0x1f, 0x8b, 0xff]).toString('base64') },
    '.next/dev/cache/webpack/x.json': '{"a":1}',
  });
  // A rewrite of the same length is a change: its mtime moves.
  const before = files[1][2];
  while (Date.now() <= before) await new Promise((r) => setTimeout(r, 1));
  vfs.write('/app/.next/dev/cache/webpack/x.json', new TextEncoder().encode('{"a":2}'));
  assert.notEqual(listCache(vfs, '/app', ['.next/dev/cache'])[1][2], before);
});
