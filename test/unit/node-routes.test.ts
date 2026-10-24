/**
 * The node adapter's host routes, asked what a sandbox's page can ask them (ADR 0029, 0033, 0037):
 * installed files only from inside an install's node_modules, and caches only under keys the host
 * handed to a run.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRequest, HostResponse } from '../../src/types.ts';

let root: string;
let serve: (req: HostRequest) => Promise<HostResponse | null>;
const KEY = '0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba98';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandburg-routes-'));
  // The adapter keeps its installs, caches and compiles beside SANDBURG_INSTALL_DIR.
  process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
  const install = join(root, 'installs', KEY);
  await mkdir(join(install, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(install, 'node_modules', 'pkg', 'data.json'), '{"ok":true}');
  await writeFile(join(install, 'package.json'), '{"secret":"the project"}');
  await writeFile(join(root, 'host-secret.txt'), 'the host');
  await symlink(join(root, 'host-secret.txt'), join(install, 'node_modules', 'pkg', 'link.json'));
  ({ serve } = await import('../../src/adapters/node/index.ts'));
});
after(() => rm(root, { recursive: true, force: true }));

function req(path: string, method = 'GET', body = ''): HostRequest {
  return { method, path, query: new URLSearchParams(), body: async () => Buffer.from(body) };
}

/** Not served: no answer (404), or an error (a 500 from the host server). */
const refused = (r: Promise<HostResponse | null>) => r.then((res) => res === null, () => true);

const text = (r: HostResponse | null) => (r ? `${r.status} ${Buffer.from(r.body as Uint8Array).toString('utf8')}` : null);

test("installed files are served from an install's node_modules and nowhere else", async () => {
  assert.equal(text(await serve(req(`/__sandburg/nm/${KEY}/f/node_modules/pkg/data.json`))), '200 {"ok":true}');
  for (const rel of [
    'package.json', // the install's own files, outside node_modules
    'node_modules/../package.json',
    'node_modules%2F..%2Fpackage.json',
    'node_modules/pkg/%2E%2E/%2E%2E/package.json',
    'node_modules/pkg/..%2F..%2F..%2Fhost-secret.txt',
    'node_modules/pkg/link.json', // a link out of the install
    'node_modules/pkg/missing.json',
  ]) {
    for (const mode of ['f', 't']) assert.ok(await refused(serve(req(`/__sandburg/nm/${KEY}/${mode}/${rel}`))), `${mode} ${rel}`);
  }
  // Keys are digests: nothing else names a directory.
  for (const key of ['..', `${KEY}/..`, KEY.toUpperCase(), OTHER]) {
    assert.ok(await refused(serve(req(`/__sandburg/nm/${key}/f/node_modules/pkg/data.json`))), key);
  }
});

test('a cache is stored only under a key the host issued, and read only when handed to a run', async () => {
  const cache = JSON.stringify({ 'node_modules/.vite/deps/x.js': 'export default "planted"' });
  for (const key of [KEY, OTHER]) {
    const res = await serve(req(`/__sandburg/dev-cache/${key}`, 'POST', cache));
    assert.equal(text(res), '403 not a cache of this run', key);
  }
  // A GET stores nothing either.
  assert.equal(await serve(req(`/__sandburg/dev-cache/${KEY}`, 'GET')), null);
  const devCache = join(root, 'dev-cache');
  assert.deepEqual(await readdir(devCache).catch(() => []), []);

  // A cache on disk (an earlier run's, or one put there) is read only for a run it was handed to.
  await mkdir(devCache, { recursive: true });
  await writeFile(join(devCache, `${KEY}.json`), cache);
  assert.equal(await serve(req(`/__sandburg/dev-cache/${KEY}/bundle`)), null);
});
