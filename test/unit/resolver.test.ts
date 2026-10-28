import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedBody, PackumentCache, revalidates, trimPackument } from '../../src/adapters/node/resolver.ts';
import { npmCliScript, npmCommand } from '../../src/adapters/node/npm-cli.ts';
import { tempDir } from './temp-dir.ts';

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
  // A packument being read ahead is returned as its promise (pacote awaits what get() returns).
  // oxlint-disable-next-line typescript/await-thenable
  assert.deepEqual(await cache.get('a'), { _contentLength: 10, v: 1 });
  // Kept once read.
  assert.deepEqual(cache.get('a'), { _contentLength: 10, v: 1 });
  let again = 0;
  cache.pending('b', Promise.reject(new Error('offline')), async () => ({ _contentLength: 10, again: ++again }) as { _contentLength: number });
  // oxlint-disable-next-line typescript/await-thenable
  assert.deepEqual(await cache.get('b'), { _contentLength: 10, again: 1 });
  assert.equal(again, 1);
});

test('only packuments npm would revalidate are read ahead', () => {
  const entry = (age: number, control: string) => ({ time: Date.now() - age * 1000, metadata: { resHeaders: { 'cache-control': control } } });
  assert.equal(revalidates(entry(10, 'public, max-age=300'), {}), false);
  assert.equal(revalidates(entry(400, 'public, max-age=300'), {}), true);
  assert.equal(revalidates(entry(10, 'no-cache'), {}), true);
  assert.equal(revalidates(entry(10, ''), {}), true);
  assert.equal(revalidates(entry(10, 'public, max-age=300'), { preferOnline: true }), true);
  assert.equal(revalidates(entry(400, 'public, max-age=300'), { preferOffline: true }), false);
  assert.equal(revalidates(entry(400, 'public, max-age=300'), { offline: true }), false);
});

/** A registry of a few packages: npm's full packuments, and the names it was asked for. */
async function registry(): Promise<{ url: string; asked: string[]; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const pkgs: Record<string, Record<string, object>> = {
    app: { '1.0.0': { dependencies: { lib: '^1.0.0' }, peerDependencies: { tool: '*', extra: '*' }, peerDependenciesMeta: { extra: { optional: true } } } },
    // Large enough to be trimmed (TRIM_MIN), mostly in fields npm's resolution does not read.
    lib: { '1.0.0': { licenseText: 'L'.repeat(40_000) }, '1.2.0': { dependencies: { leaf: '~2.0.0' }, licenseText: 'L'.repeat(40_000), exports: { '.': './index.js' } }, '2.0.0': {} },
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
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { Resolver } = await import('../../src/adapters/node/resolver.ts');
  const reg = await registry();
  const env = { npm_config_registry: process.env.npm_config_registry, npm_config_cache: process.env.npm_config_cache };
  try {
    const root = tempDir('sandburg-resolver-');
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
    const npm = (dir: string) => promisify(execFile)(...npmCommand(['install', ...flags, '--no-update-notifier']), { cwd: dir, env: process.env });
    await npm(dirs.other);
    reg.asked.splice(0);
    await npm(dirs.cli);
    const cliAsked = reg.asked.splice(0).sort();
    assert.ok(!cliAsked.includes('heavy') && cliAsked.includes('extra'));
    const resolver = new Resolver(join(root, 'resolver'), flags);
    // Warmed as a session opens: it reads nothing from the registry, and changes nothing below.
    resolver.warm();
    assert.equal(await resolver.resolve(dirs.first, () => {}), true);
    // What npm read, and nothing else (heavy is in npm's cache, but only an optional peer depends on it).
    assert.deepEqual(reg.asked.splice(0).sort(), cliAsked);
    assert.equal(await resolver.resolve(dirs.again, () => {}), true);
    const expected = await readFile(join(dirs.cli, 'package-lock.json'), 'utf8');
    assert.equal(await readFile(join(dirs.first, 'package-lock.json'), 'utf8'), expected);
    assert.equal(await readFile(join(dirs.again, 'package-lock.json'), 'utf8'), expected);
    // Kept in the resolver: read once.
    assert.deepEqual(reg.asked, []);
    // A directory reached through a link (macOS's temporary directory is under /var, a link to
    // /private/var) has the same lockfile.
    const real = join(root, 'linked-real');
    await mkdir(real);
    await writeFile(join(real, 'package.json'), manifest);
    const { symlink } = await import('node:fs/promises');
    await symlink(real, join(root, 'linked'), 'junction');
    assert.equal(await resolver.resolve(join(root, 'linked'), () => {}), true);
    assert.equal(await readFile(join(real, 'package-lock.json'), 'utf8'), expected);
  } finally {
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    await reg.close();
  }
});

test('a trimmed packument keeps what npm resolves and writes in lockfiles', () => {
  const version = {
    name: 'p', version: '1.0.0', license: 'MIT', dependencies: { a: '1' }, optionalDependencies: { b: '1' }, peerDependencies: { c: '1' }, peerDependenciesMeta: { c: { optional: true } },
    bundleDependencies: ['a'], engines: { node: '>=18' }, os: ['linux'], cpu: ['x64'], libc: ['glibc'], bin: { p: 'bin.js' }, funding: 'https://example.com', deprecated: 'old', scripts: { install: 'node-gyp rebuild' },
    _hasShrinkwrap: false, hasInstallScript: true, gypfile: true, _id: 'p@1.0.0',
    dist: { tarball: 'https://r/p.tgz', integrity: 'sha512-x', shasum: 'abc', signatures: [{ sig: 's' }], 'npm-signature': 'pgp', attestations: { url: 'u' }, fileCount: 3, unpackedSize: 9 },
    licenseText: 'L'.repeat(1000), readme: 'R', exports: { '.': './i.js' }, devDependencies: { d: '1' }, maintainers: [{ name: 'm' }], _npmUser: { name: 'u' }, gitHead: 'g',
  };
  const trimmed = trimPackument({ name: 'p', 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': 't' }, readme: 'R', users: { u: true }, versions: { '1.0.0': version } })!;
  assert.deepEqual(Object.keys(trimmed).sort(), ['dist-tags', 'name', 'time', 'versions']);
  const kept = (trimmed.versions as Record<string, Record<string, unknown>>)['1.0.0'];
  assert.deepEqual(kept.dist, { tarball: 'https://r/p.tgz', integrity: 'sha512-x', shasum: 'abc' });
  for (const field of ['licenseText', 'readme', 'exports', 'devDependencies', 'maintainers', '_npmUser', 'gitHead']) assert.ok(!(field in kept), field);
  const { dist: _d, licenseText: _l, readme: _r, exports: _e, devDependencies: _dd, maintainers: _m, _npmUser: _u, gitHead: _g, ...rest } = version;
  assert.deepEqual({ ...kept, dist: undefined }, { ...rest, dist: undefined });
  assert.equal(trimPackument({ name: 'x' }), null);
  assert.equal(trimPackument([1]), null);
});

test('packuments are trimmed into npm\'s cache; a later resolution reads them, and a changed one is refused', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { execFile, execFileSync } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createRequire } = await import('node:module');
  const { realpathSync } = await import('node:fs');
  const { Resolver } = await import('../../src/adapters/node/resolver.ts');
  // npm's own package: on Windows its npm-cli.js (`npm` there is a batch file), else the CLI on PATH.
  const npmRoot = dirname(dirname(process.platform === 'win32' ? npmCliScript()! : realpathSync(execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim())));
  const cacache = createRequire(join(npmRoot, 'package.json'))('cacache') as {
    ls(cache: string): Promise<Record<string, { integrity: string; metadata?: { source?: string } }>>;
    put(cache: string, key: string, data: string, o: object): Promise<unknown>;
    get(cache: string, key: string): Promise<{ data: Buffer; metadata: { source: string } }>;
  };
  const reg = await registry();
  const env = { npm_config_registry: process.env.npm_config_registry, npm_config_cache: process.env.npm_config_cache };
  try {
    const root = tempDir('sandburg-trim-');
    process.env.npm_config_registry = reg.url;
    process.env.npm_config_cache = join(root, 'npm-cache');
    const cache = join(root, 'npm-cache', '_cacache');
    const flags = ['--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error'];
    const manifest = JSON.stringify({ name: 'sandburg-install', private: true, dependencies: { app: '^1.0.0', tool: '^3.0.0' }, devDependencies: { lib: '1' } });
    const dir = async (name: string) => {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'package.json'), manifest);
      return join(root, name);
    };
    const resolve = async (name: string) => {
      // A new worker each time: nothing kept in memory between resolutions.
      const d = await dir(name);
      assert.equal(await new Resolver(join(root, `resolver-${name}`), flags).resolve(d, () => {}), true);
      return readFile(join(d, 'package-lock.json'), 'utf8');
    };
    const cli = await dir('cli');
    await promisify(execFile)(...npmCommand(['install', ...flags, '--no-update-notifier']), { cwd: cli, env: process.env });
    const expected = await readFile(join(cli, 'package-lock.json'), 'utf8');
    const key = `sandburg:packument-trim:1:make-fetch-happen:request-cache:${reg.url}lib`;
    // The first resolution reads the full packument (the CLI cached it) and trims it on the side.
    assert.equal(await resolve('first'), expected);
    for (let i = 0; i < 100 && !(key in (await cacache.ls(cache))); i++) await new Promise((r) => setTimeout(r, 50));
    const stored = await cacache.get(cache, key);
    const trimmed = JSON.parse(stored.data.toString()) as { versions: Record<string, Record<string, unknown>> };
    assert.ok(!('licenseText' in trimmed.versions['1.2.0']) && !('exports' in trimmed.versions['1.2.0']));
    assert.equal(stored.metadata.source, (await cacache.ls(cache))[`make-fetch-happen:request-cache:${reg.url}lib`].integrity);
    // Read again: the same lockfile from the trimmed packument.
    assert.equal(await resolve('again'), expected);
    // It is what npm reads: one without lib@1.2.0, stored for the same source, picks 1.0.0.
    const without = { ...trimmed, versions: { '1.0.0': trimmed.versions['1.0.0'], '2.0.0': trimmed.versions['2.0.0'] } };
    await cacache.put(cache, key, JSON.stringify(without), { metadata: { source: stored.metadata.source } });
    assert.match(await resolve('planted'), /"node_modules\/lib": \{\s*"version": "1\.0\.0"/);
    // Stored for another source (the packument changed since): not read.
    await cacache.put(cache, key, JSON.stringify(without), { metadata: { source: 'sha512-other' } });
    assert.equal(await resolve('stale'), expected);
    // ... and trimmed again from what was read.
    for (let i = 0; i < 100 && (await cacache.ls(cache))[key].metadata?.source !== stored.metadata.source; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await cacache.ls(cache))[key].metadata?.source, stored.metadata.source);
    // Bytes that changed on disk (that npm would resolve to lib@1.0.0): cacache's integrity check
    // refuses them, and the full packument is read.
    await cacache.put(cache, key, JSON.stringify(trimmed), { metadata: { source: stored.metadata.source } });
    const { integrity } = (await cacache.ls(cache))[key];
    const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
    await writeFile(join(cache, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), JSON.stringify(without));
    assert.equal(await resolve('tampered'), expected);
  } finally {
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    await reg.close();
  }
});

test('the resolver answers whether a version matches, as npm view does', async () => {
  const { join } = await import('node:path');
  const { Resolver } = await import('../../src/adapters/node/resolver.ts');
  const reg = await registry();
  const env = { npm_config_registry: process.env.npm_config_registry, npm_config_cache: process.env.npm_config_cache };
  try {
    const root = tempDir('sandburg-view-');
    process.env.npm_config_registry = reg.url;
    process.env.npm_config_cache = join(root, 'npm-cache');
    const resolver = new Resolver(join(root, 'resolver'), ['--package-lock-only', '--ignore-scripts', '--loglevel=error']);
    assert.equal(await resolver.view('lib@^1.0.0'), '1.2.0');
    assert.equal(await resolver.view('leaf@~2.0.0'), '2.0.1');
    // No such version, no such package: as npm view prints nothing.
    assert.equal(await resolver.view('lib@^9.0.0'), null);
    assert.equal(await resolver.view('lightningcss-wasm32-wasi@^1.0.0'), null);
  } finally {
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    await reg.close();
  }
});

test("only responses from npm's own cache are trimmed: headers naming another directory are not followed", () => {
  const response = (cache: string) => {
    const headers: Record<string, string> = { 'x-local-cache': encodeURIComponent(cache), 'x-local-cache-key': encodeURIComponent('make-fetch-happen:request-cache:https://registry.npmjs.org/p'), 'x-local-cache-hash': 'sha512-x', 'content-length': String(1 << 20) };
    return { status: 200, headers: { get: (name: string) => headers[name] ?? null } };
  };
  assert.deepEqual(cachedBody(response('/home/u/.npm/_cacache'), '/home/u/.npm/_cacache')?.cache, '/home/u/.npm/_cacache');
  // A response make-fetch-happen did not store keeps the registry's headers.
  assert.equal(cachedBody(response('/tmp/elsewhere'), '/home/u/.npm/_cacache'), null);
  // Before npm has loaded, its cache is not known: nothing is trimmed.
  assert.equal(cachedBody(response('/home/u/.npm/_cacache'), null), null);
});
