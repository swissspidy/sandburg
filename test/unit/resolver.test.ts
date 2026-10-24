import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackumentCache } from '../../src/adapters/node/resolver.ts';

test('the resolver keeps packuments by their size, least recently used out first', () => {
  const cache = new PackumentCache(100);
  cache.set('a', { _contentLength: 40 });
  cache.set('b', { _contentLength: 40 });
  assert.ok(cache.get('a')); // a is now the most recently used
  cache.set('c', { _contentLength: 40 });
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  // Without a length it cannot be counted, and over half the budget it would push out the rest.
  cache.set('d', {});
  cache.set('e', { _contentLength: 60 });
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  cache.delete('a');
  cache.set('f', { _contentLength: 50 });
  assert.deepEqual([...cache.keys()], ['c', 'f']);
});

test('a packument read ahead is what pacote gets, and one that fails is read again', async () => {
  const cache = new PackumentCache(100);
  cache.pending('a', Promise.resolve({ _contentLength: 10, v: 1 } as { _contentLength: number }), () => Promise.reject(new Error('not again')));
  assert.ok(cache.has('a'));
  assert.deepEqual(await cache.get('a'), { _contentLength: 10, v: 1 });
  // Kept once read.
  assert.deepEqual(cache.get('a'), { _contentLength: 10, v: 1 });
  let again = 0;
  cache.pending('b', Promise.reject(new Error('offline')), async () => ({ _contentLength: 10, again: ++again }) as { _contentLength: number });
  assert.deepEqual(await cache.get('b'), { _contentLength: 10, again: 1 });
  assert.equal(again, 1);
});

/** A registry of a few packages: npm's full packuments, and the names it was asked for. */
async function registry(): Promise<{ url: string; asked: string[]; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const pkgs: Record<string, Record<string, object>> = {
    app: { '1.0.0': { dependencies: { lib: '^1.0.0' }, peerDependencies: { tool: '*', extra: '*' }, peerDependenciesMeta: { extra: { optional: true } } } },
    lib: { '1.0.0': {}, '1.2.0': { dependencies: { leaf: '~2.0.0' } }, '2.0.0': {} },
    leaf: { '2.0.1': {}, '2.1.0': {} },
    tool: { '3.0.0': { peerDependencies: { app: '^1.0.0' } } },
    // Only an optional peer: npm reads its peers, never its dependencies.
    extra: { '1.0.0': { dependencies: { heavy: '*' }, peerDependencies: { tool: '*' } } },
    heavy: { '1.0.0': {} },
  };
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url!.slice(1));
    asked.push(name);
    const versions = pkgs[name];
    if (!versions) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const doc = {
      name,
      'dist-tags': { latest: Object.keys(versions).at(-1) },
      versions: Object.fromEntries(
        Object.entries(versions).map(([v, m]) => [
          v,
          { name, version: v, license: 'MIT', ...m, dist: { tarball: `${base}/${name}/-/${name}-${v}.tgz`, integrity: `sha512-${createHash('sha512').update(`${name}@${v}`).digest('base64')}` } },
        ]),
      ),
      time: Object.fromEntries(Object.keys(versions).map((v) => [v, '2026-01-01T00:00:00.000Z'])),
    };
    const body = JSON.stringify(doc);
    // Stale at once: every read of a cached packument asks the registry again (and gets a 304), so
    // the registry sees each one.
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, { etag, 'cache-control': 'public, max-age=0' }).end();
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'public, max-age=0', etag }).end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, asked, close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) };
}

test('the resolver writes the lockfile npm does, and reads ahead only what npm reads', async () => {
  const { mkdir, mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { Resolver } = await import('../../src/adapters/node/resolver.ts');
  const reg = await registry();
  const env = { npm_config_registry: process.env.npm_config_registry, npm_config_cache: process.env.npm_config_cache };
  try {
    const root = await mkdtemp(join(tmpdir(), 'sandburg-resolver-'));
    process.env.npm_config_registry = reg.url;
    process.env.npm_config_cache = join(root, 'npm-cache');
    const flags = ['--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error'];
    const manifest = JSON.stringify({ name: 'sandburg-install', private: true, dependencies: { app: '^1.0.0', tool: '^3.0.0' }, devDependencies: { lib: '1' } });
    const dirs = { other: join(root, 'other'), cli: join(root, 'cli'), first: join(root, 'first'), again: join(root, 'again') };
    for (const dir of Object.values(dirs)) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), manifest);
    }
    // Another app had heavy: npm's cache has its packument, which this resolution does not need.
    await writeFile(join(dirs.other, 'package.json'), JSON.stringify({ name: 'other', private: true, dependencies: { heavy: '1' } }));
    const npm = (dir: string) => promisify(execFile)('npm', ['install', ...flags, '--no-update-notifier'], { cwd: dir, env: process.env });
    await npm(dirs.other);
    reg.asked.splice(0);
    await npm(dirs.cli);
    const cliAsked = reg.asked.splice(0).sort();
    assert.ok(!cliAsked.includes('heavy') && cliAsked.includes('extra'));
    const resolver = new Resolver(join(root, 'resolver'), flags);
    assert.equal(await resolver.resolve(dirs.first, () => {}), true);
    // What npm read, and nothing else (heavy is in npm's cache, but only an optional peer depends on it).
    assert.deepEqual(reg.asked.splice(0).sort(), cliAsked);
    assert.equal(await resolver.resolve(dirs.again, () => {}), true);
    const expected = await readFile(join(dirs.cli, 'package-lock.json'), 'utf8');
    assert.equal(await readFile(join(dirs.first, 'package-lock.json'), 'utf8'), expected);
    assert.equal(await readFile(join(dirs.again, 'package-lock.json'), 'utf8'), expected);
    // Kept in the resolver: read once.
    assert.deepEqual(reg.asked, []);
  } finally {
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    await reg.close();
  }
});
