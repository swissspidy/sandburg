/**
 * Caches on one .sandburg/ written by more than one Session or process at once: no writer replaces
 * what another one is serving from, and no entry is put together from two writers' parts.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Project } from '../../src/types.ts';

const root = mkdtempSync(join(tmpdir(), 'sandburg-concurrent-'));
process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
after(() => rmSync(root, { recursive: true, force: true }));

test('installs: two installers finishing the same install keep the first one in place', async () => {
  const { Installer } = await import('../../src/adapters/node/install.ts');
  const installs = join(root, 'race-installs');
  // No dependencies: npm resolves an empty tree, without the registry.
  const project = { files: { 'package.json': '{"name":"race"}' }, packageJson: { name: 'race' } } as unknown as Project;
  const [a, b] = [new Installer(installs), new Installer(installs)];
  // Both start before either is done; each looks at its directory as soon as it has it, as a run would.
  const seen = await Promise.all([a, b].map((i) => i.install(project, {}, () => {}).then((info) => ({ dir: info.dir, ino: lstatSync(info.dir).ino }))));
  assert.equal(seen[0].dir, seen[1].dir);
  // The one that finished second did not remove the first one's directory and put its own there.
  assert.equal(seen[0].ino, seen[1].ino);
  assert.equal(lstatSync(seen[0].dir).ino, seen[0].ino);
  assert.ok(existsSync(join(seen[0].dir, '.sandburg-complete')));
  // Nor is its own left behind.
  assert.deepEqual(
    readdirSync(installs).filter((n) => n.includes('.tmp-')),
    [],
  );
});

test('egress cache: metadata is only trusted with the body it was written with', async () => {
  const { readCache, writeCache } = await import('../../src/orchestrator/egress.ts');
  const path = join(root, 'egress', 'ab', 'entry');
  const one = { status: 200, headers: { 'content-type': 'application/json', etag: '"1"' }, body: Buffer.from('{"v":1}') };
  const two = { status: 200, headers: { 'content-type': 'application/json', etag: '"2"' }, body: Buffer.from('{"v":2,"more":true}') };
  await writeCache(path, 'https://registry.npmjs.org/x', one);
  assert.deepEqual((await readCache(path))?.body, one.body);
  // Two processes fetching the same URL: one's body, then the other's metadata, land last.
  const meta = readFileSync(`${path}.json`, 'utf8');
  await writeCache(path, 'https://registry.npmjs.org/x', two);
  writeFileSync(`${path}.json`, meta);
  assert.equal(await readCache(path), null);
  // Entries written before the digest was recorded are read as before.
  const { body: _, ...old } = JSON.parse(meta) as Record<string, unknown>;
  writeFileSync(`${path}.json`, JSON.stringify(old));
  assert.deepEqual((await readCache(path))?.body, two.body);
});

test('preload lists: a process that writes a list keeps what another process recorded in it', async () => {
  // Two copies of the preload lists' module, as two processes on one .sandburg/ (each keeps its lists
  // in memory; the module that holds them is preload.ts since the node adapter's split).
  type Preload = typeof import('../../src/adapters/node/preload.ts');
  const preload = '../../src/adapters/node/preload.ts';
  const a = (await import(`${preload}?process=a`)) as Preload;
  const b = (await import(`${preload}?process=b`)) as Preload;
  const key = 'f'.repeat(24);
  const files: Record<string, string> = {
    'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0' }),
    'node_modules/pkg/a.json': '{"a":1}',
    'node_modules/pkg/b.json': '{"b":1}',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'installs', key, path)), { recursive: true });
    writeFileSync(join(root, 'installs', key, path), content);
  }
  const list = join(root, 'dev-cache', `preload-${key}.json`);
  const saved = () => (existsSync(list) ? (JSON.parse(readFileSync(list, 'utf8')) as string[]) : []);
  // Lists are written 2 s after a file is first recorded: b writes its list while a has its own in
  // memory (read before b wrote), and a writes later.
  await b.recordLoad(key, 'f', 'node_modules/pkg/b.json');
  await new Promise((r) => setTimeout(r, 1_000));
  await a.recordLoad(key, 'f', 'node_modules/pkg/a.json');
  await new Promise((r) => setTimeout(r, 1_500));
  assert.deepEqual(saved(), ['f:node_modules/pkg/b.json']);
  await new Promise((r) => setTimeout(r, 1_500));
  assert.deepEqual(saved(), ['f:node_modules/pkg/a.json', 'f:node_modules/pkg/b.json']);
});
