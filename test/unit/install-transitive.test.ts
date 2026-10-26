import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resolver } from '../../src/adapters/node/resolver.ts';
import { assertRegistryLockfile, registryOrigins, UnsupportedDependencyError } from '../../src/adapters/node/spec-guard.ts';
import { tempDir } from './temp-dir.ts';

// A registry package may declare a transitive git, directory or off-registry-tarball dependency. The
// host must not fetch it during resolution and must not install it. A remote-tarball dependency is
// refused during resolution before it is fetched; a directory/file dependency, which npm resolves
// locally, is refused by the check on the resolved tree before any install step runs.

/** A fake npm registry serving the given packages. */
async function fakeRegistry(packages: Record<string, Record<string, object>>): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const versions = packages[name];
    if (!versions) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const doc = {
      name,
      'dist-tags': { latest: Object.keys(versions).at(-1) },
      versions: Object.fromEntries(
        Object.entries(versions).map(([v, m]) => [v, { name, version: v, ...m, dist: { tarball: `${base}/${name}/-/${name}-${v}.tgz`, integrity: `sha512-${createHash('sha512').update(`${name}@${v}`).digest('base64')}` } }]),
      ),
      time: {},
    };
    const body = JSON.stringify(doc);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'public, max-age=0' }).end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise<void>((done) => (server.close(() => done()), server.closeAllConnections())) };
}

test('a registry package depending on an off-registry tarball is refused during resolution, with no request to that host', async () => {
  let hits = 0;
  const evil = createServer((_req, res) => ((hits += 1), res.writeHead(200).end('nope')));
  await new Promise<void>((done) => evil.listen(0, '127.0.0.1', done));
  const evilOrigin = `http://127.0.0.1:${(evil.address() as { port: number }).port}`;
  const reg = await fakeRegistry({ badremote: { '1.0.0': { dependencies: { planted: `${evilOrigin}/planted.tgz` } } } });
  const env = { npm_config_registry: process.env.npm_config_registry, npm_config_cache: process.env.npm_config_cache };
  try {
    const root = tempDir('sandburg-transitive-');
    process.env.npm_config_registry = reg.url;
    process.env.npm_config_cache = join(root, 'npm-cache');
    const resolver = new Resolver(join(root, 'resolver'), ['--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error']);
    const dir = join(root, 'app');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies: { badremote: '^1.0.0' } }));
    await assert.rejects(() => resolver.resolve(dir, () => {}), (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'UNSUPPORTED');
    assert.equal(hits, 0, 'the off-registry host was never requested');
  } finally {
    Object.assign(process.env, env);
    await reg.close();
    await new Promise<void>((done) => (evil.close(() => done()), evil.closeAllConnections()));
  }
});

test('a registry package depending on a file: path resolves to a tree the lockfile check refuses', async () => {
  const reg = await fakeRegistry({ badfile: { '1.0.0': { dependencies: { planted: 'file:../planted' } } } });
  const env = { npm_config_registry: process.env.npm_config_registry, npm_config_cache: process.env.npm_config_cache };
  try {
    const root = tempDir('sandburg-transitive-file-');
    process.env.npm_config_registry = reg.url;
    process.env.npm_config_cache = join(root, 'npm-cache');
    const resolver = new Resolver(join(root, 'resolver'), ['--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error']);
    const dir = join(root, 'app');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies: { badfile: '^1.0.0' } }));
    await resolver.resolve(dir, () => {});
    const lock = await readFile(join(dir, 'package-lock.json'), 'utf8');
    // The resolved tree carries the transitive file: spec; refused before any install step runs.
    assert.throws(() => assertRegistryLockfile(lock), UnsupportedDependencyError);
  } finally {
    Object.assign(process.env, env);
    await reg.close();
  }
});

test('registryOrigins and assertRegistryLockfile reject a resolved URL on another host', () => {
  const env = process.env.npm_config_registry;
  try {
    delete process.env.npm_config_registry;
    const lock = (resolved: string) => JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0', resolved, integrity: 'sha512-x' } } });
    assert.doesNotThrow(() => assertRegistryLockfile(lock('https://registry.npmjs.org/x/-/x-1.0.0.tgz')));
    assert.throws(() => assertRegistryLockfile(lock('https://evil.example/x.tgz')), UnsupportedDependencyError);
    process.env.npm_config_registry = 'http://127.0.0.1:4873/';
    assert.ok(registryOrigins().has('http://127.0.0.1:4873'));
    assert.doesNotThrow(() => assertRegistryLockfile(lock('http://127.0.0.1:4873/x/-/x-1.0.0.tgz')));
    assert.throws(() => assertRegistryLockfile(lock('http://127.0.0.1:9999/x.tgz')), UnsupportedDependencyError);
  } finally {
    if (env === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = env;
  }
});
