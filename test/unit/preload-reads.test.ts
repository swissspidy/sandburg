/**
 * Preload bundles hold what runs read (markRead in src/adapters/node/index.ts): once runtimes say
 * which of a bundle's files they read, the install's next bundle holds those, and the files they asked
 * for one by one. A report names files of the install only, and only the sandboxes of runs the
 * install was made for shape it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sandburg-reads-'));
process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
const { serve, preloadEntries, grantReads } = await import('../../src/adapters/node/index.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const key = 'd'.repeat(24);
const files = ['node_modules/p/package.json', 'node_modules/p/a.js', 'node_modules/p/b.js', 'node_modules/p/c.js', 'node_modules/p/d.js'];
for (const path of files) {
  mkdirSync(dirname(join(root, 'installs', key, path)), { recursive: true });
  writeFileSync(join(root, 'installs', key, path), path.endsWith('.json') ? '{"name":"p","version":"1.0.0"}' : 'module.exports = 1;');
}
// What earlier runs of the install loaded (a first run's prediction included), before runs said what they read.
mkdirSync(join(root, 'dev-cache'), { recursive: true });
writeFileSync(join(root, 'dev-cache', `preload-${key}.json`), JSON.stringify(['t:node_modules/p/a.js', 'f:node_modules/p/b.js', 't:node_modules/p/c.js', 't:node_modules/p/d.js']));

const request = (path: string, query: Record<string, string> = {}, sandbox = 's-own') => serve({ method: 'GET', path, query: new URLSearchParams(query), sandbox, body: async () => Buffer.alloc(0) });
const report = (k: string, entries: string[], sandbox = 's-own') => request(`/__sandburg/nm/${k}/read`, { files: entries.join('\n') }, sandbox);
// The install's run is in sandbox s-own.
grantReads(key, Promise.resolve('s-own'));
await new Promise((r) => setImmediate(r));

test('until runs say what they read, a bundle holds every file runs loaded', async () => {
  assert.deepEqual(await preloadEntries(key), ['t:node_modules/p/a.js', 'f:node_modules/p/b.js', 't:node_modules/p/c.js', 't:node_modules/p/d.js']);
});

test('another sandbox does not shape the install\'s bundles, by reports or by the files it asks for', async () => {
  // It serves itself files by key (as any sandbox may), and reports a subset, with and without a sandbox.
  assert.equal((await request(`/__sandburg/nm/${key}/f/node_modules/p/b.js`, {}, 's-other'))?.status, 200);
  assert.equal((await report(key, ['t/node_modules/p/a.js'], 's-other'))?.status, 204);
  assert.equal((await serve({ method: 'GET', path: `/__sandburg/nm/${key}/read`, query: new URLSearchParams({ files: 't/node_modules/p/a.js' }), body: async () => Buffer.alloc(0) }))?.status, 204);
  // A run of another install, granted for its own key only.
  grantReads('e'.repeat(24), Promise.resolve('s-else'));
  await new Promise((r) => setImmediate(r));
  assert.equal((await report(key, ['t/node_modules/p/a.js'], 's-else'))?.status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await preloadEntries(key)).length, 4);
});

test('then what they read from bundles and asked for, in the order first loaded', async () => {
  // Reports that name nothing of the install change nothing: other paths, modes, escapes, another install.
  for (const bogus of [['t/node_modules/q/x.js'], ['x/node_modules/p/b.js'], ['t:node_modules/p/b.js'], ['t/node_modules/p/../p/b.js'], ['']]) assert.equal((await report(key, bogus))?.status, 204);
  assert.equal((await report('e'.repeat(24), ['t/node_modules/p/a.js']))?.status, 204);
  assert.equal((await preloadEntries(key)).length, 4);

  assert.equal((await report(key, ['t/node_modules/p/c.js', 't/node_modules/p/a.js']))?.status, 204);
  assert.deepEqual(await preloadEntries(key), ['t:node_modules/p/a.js', 't:node_modules/p/c.js']);
  // A file asked for on its own is read too.
  assert.equal((await request(`/__sandburg/nm/${key}/f/node_modules/p/b.js`))?.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await preloadEntries(key), ['t:node_modules/p/a.js', 'f:node_modules/p/b.js', 't:node_modules/p/c.js']);
});
