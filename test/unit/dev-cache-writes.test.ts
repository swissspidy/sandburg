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

test('a stored cache\'s digests are kept beside it, and computed again once the cache is written again', async () => {
  const { createHash } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const key = 'd'.repeat(24);
  const write = async (files: Record<string, string>) => {
    const token = node.issueCacheWrite(key, DIRS, Promise.resolve('s-d'));
    await new Promise((r) => setImmediate(r));
    assert.equal((await post(key, 's-d', token, files))?.status, 200);
  };
  // Only files under the run's directories are stored (writeDevCache).
  await write({ '.next/dev/cache/a': 'one', 'elsewhere/b': 'not kept' });
  assert.deepEqual(await node.devCacheDigests(key, DIRS), { count: 1, digests: { '.next/dev/cache/a': sha('one') } });
  const side = `${cacheFile(key)}.digests`;
  const kept = JSON.parse(await readFile(side, 'utf8')) as { from: string; digests: Record<string, string> };
  assert.deepEqual(kept.digests, { '.next/dev/cache/a': sha('one') });
  // Read from beside the cache while the cache is the same file (a record marked to tell).
  await writeFile(side, JSON.stringify({ ...kept, digests: { '.next/dev/cache/a': 'from the record' } }));
  assert.deepEqual((await node.devCacheDigests(key, DIRS)).digests, { '.next/dev/cache/a': 'from the record' });
  // Other directories, or a record that is not one: computed from the cache.
  assert.deepEqual(await node.devCacheDigests(key, ['.next/dev/other']), { count: 0, digests: {} });
  await writeFile(side, '{"from":1}');
  assert.deepEqual((await node.devCacheDigests(key, DIRS)).digests, { '.next/dev/cache/a': sha('one') });
  // The cache written again: computed again.
  await write({ '.next/dev/cache/a': 'two', '.next/dev/cache/c': 'three' });
  assert.deepEqual(await node.devCacheDigests(key, DIRS), { count: 2, digests: { '.next/dev/cache/a': sha('two'), '.next/dev/cache/c': sha('three') } });
  assert.deepEqual(await node.devCacheDigests('e'.repeat(24), DIRS), { count: 0, digests: {} });
});
