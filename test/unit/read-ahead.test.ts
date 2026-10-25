import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HostRequest } from '../../src/types.ts';

// The node adapter serves from the shared installer, rooted here (set before it is loaded).
const root = mkdtempSync(join(tmpdir(), 'sandburg-ahead-'));
process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
const { serve } = await import('../../src/adapters/node/index.ts');
const { MAX_BODY } = await import('../../src/orchestrator/host-socket.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const key = 'c'.repeat(24);
const files: Record<string, string> = {
  'node_modules/icons/package.json': JSON.stringify({ name: 'icons', version: '1.0.0' }),
  'node_modules/icons/esm/a.js': 'export default "a";',
  'node_modules/icons/esm/a.js.map': '{"version":3}',
  'node_modules/icons/esm/b.js': 'export default "b";',
  'node_modules/icons/esm/big.js': 'x'.repeat(100 << 10),
  'node_modules/icons/esm/c.js': 'export default "c";',
  'node_modules/icons/esm/d.js': 'export default "d";',
  'node_modules/other/index.js': 'module.exports = 1;',
};
for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(join(root, 'installs', key, path)), { recursive: true });
  writeFileSync(join(root, 'installs', key, path), content);
}

const get = (rel: string, query = '') =>
  serve({ method: 'GET', path: `/__sandburg/nm/${key}/f/${rel}`, query: new URLSearchParams(query), body: async () => Buffer.alloc(0) } as HostRequest);

/** The files of a read-ahead answer (the preload bundle's format), as path → text. */
function bundle(body: string | Uint8Array): [string, string][] {
  const bytes = Buffer.from(body as Uint8Array);
  const length = bytes.readUInt32LE(0);
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString()) as [string, string, number][];
  let at = 4 + length;
  return header.map(([mode, rel, size]) => {
    assert.equal(mode, 'f');
    const text = bytes.subarray(at, at + size).toString();
    at += size;
    return [rel, text];
  });
}

test('read-ahead: a raw file comes with the files after it in its directory, not large ones', async () => {
  const out = await get('node_modules/icons/esm/a.js', 'ahead=1');
  assert.equal(out?.status, 207);
  assert.deepEqual(bundle(out!.body), [
    ['node_modules/icons/esm/a.js', files['node_modules/icons/esm/a.js']],
    ['node_modules/icons/esm/a.js.map', files['node_modules/icons/esm/a.js.map']],
    ['node_modules/icons/esm/b.js', files['node_modules/icons/esm/b.js']],
    ['node_modules/icons/esm/c.js', files['node_modules/icons/esm/c.js']],
    ['node_modules/icons/esm/d.js', files['node_modules/icons/esm/d.js']],
  ]);
});

test('read-ahead: an answer stops at the name the runtime has files from', async () => {
  const out = await get('node_modules/icons/esm/a.js', 'ahead=1&until=c.js');
  assert.deepEqual(bundle(out!.body).map(([rel]) => rel), ['node_modules/icons/esm/a.js', 'node_modules/icons/esm/a.js.map', 'node_modules/icons/esm/b.js']);
  // Nothing to send with it: a plain answer.
  const last = await get('node_modules/icons/esm/d.js', 'ahead=1');
  assert.equal(last?.status, 200);
  assert.equal(String(last?.body), files['node_modules/icons/esm/d.js']);
});

test('read-ahead: files the runtime used are recorded as loaded, and then left out (they are in the preload bundle)', async () => {
  assert.equal((await get('node_modules/icons/esm/b.js', 'used=1'))?.status, 204);
  // A path outside the install is not recorded (and not read).
  assert.equal((await get('node_modules/../../../etc/passwd', 'used=1'))?.status, 204);
  // Recording is asynchronous.
  await new Promise((r) => setTimeout(r, 50));
  // b.js was used, d.js asked for (above).
  const out = await get('node_modules/icons/esm/a.js', 'ahead=1');
  assert.deepEqual(bundle(out!.body).map(([rel]) => rel), ['node_modules/icons/esm/a.js', 'node_modules/icons/esm/a.js.map', 'node_modules/icons/esm/c.js']);
});

test('read-ahead: only files of the install, and an answer fits the file channel', async () => {
  assert.equal(await get('node_modules/icons/../../../../etc/passwd', 'ahead=1'), null);
  assert.equal(await get('node_modules/icons/esm/missing.js', 'ahead=1'), null);
  // A directory larger than one answer: the answer stops at its budget, under the channel's limit.
  for (let i = 0; i < 400; i++) writeFileSync(join(root, 'installs', key, 'node_modules/other', `f${String(i).padStart(3, '0')}.js`), 'y'.repeat(4000));
  const big = 'd'.repeat(24);
  mkdirSync(join(root, 'installs', big), { recursive: true });
  const { cpSync } = await import('node:fs');
  cpSync(join(root, 'installs', key, 'node_modules'), join(root, 'installs', big, 'node_modules'), { recursive: true });
  const out = await serve({ method: 'GET', path: `/__sandburg/nm/${big}/f/node_modules/other/f000.js`, query: new URLSearchParams('ahead=1'), body: async () => Buffer.alloc(0) } as HostRequest);
  assert.equal(out?.status, 207);
  const sent = bundle(out!.body);
  assert.ok(sent.length > 50 && sent.length < 400, `${sent.length} files`);
  assert.ok(Buffer.from(out!.body as Uint8Array).length < MAX_BODY);
  assert.deepEqual(sent[0], ['node_modules/other/f000.js', 'y'.repeat(4000)]);
});

test('push: a transform comes with the transformed modules it requires, each once per file channel', async () => {
  const { sharedInstaller } = await import('../../src/adapters/node/install.ts');
  const { Prefetcher } = await import('../../src/adapters/node/prefetch.ts');
  const { pushAhead } = await import('../../src/adapters/node/index.ts');
  const app = 'e'.repeat(24);
  const tree: Record<string, string> = {
    'node_modules/tool/package.json': JSON.stringify({ name: 'tool', main: 'index.js' }),
    'node_modules/tool/index.js': `module.exports = require('./a.js') + require('dep');`,
    'node_modules/tool/a.js': `module.exports = require('./b.js');`,
    'node_modules/tool/b.js': `module.exports = 1;`,
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', main: 'main.js' }),
    'node_modules/dep/main.js': `module.exports = 2;`,
    'node_modules/dep/never.js': `module.exports = 3;`,
  };
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, 'installs', app, path)), { recursive: true });
    writeFileSync(join(root, 'installs', app, path), content);
  }
  const installer = sharedInstaller();
  const prefetcher = new Prefetcher(installer, app, await installer.index(app));
  prefetcher.add('node_modules/tool/index.js');
  await prefetcher.idle();
  const first = (await installer.file(app, 'node_modules/tool/index.js'))!.body;
  const channel = {};
  const out = pushAhead(app, 'node_modules/tool/index.js', first, prefetcher, channel)!;
  const files = (() => {
    const length = out.readUInt32LE(0);
    return (JSON.parse(out.subarray(4, 4 + length).toString()) as [string, string, number][]).map(([mode, rel]) => `${mode}:${rel}`);
  })();
  // Breadth first, with each module's package.json once; never.js is required by nothing.
  assert.deepEqual(files, ['t:node_modules/tool/index.js', 't:node_modules/tool/a.js', 'f:node_modules/tool/package.json', 't:node_modules/dep/main.js', 'f:node_modules/dep/package.json', 't:node_modules/tool/b.js']);
  // The same channel gets nothing again; another channel (another runtime) does.
  assert.equal(pushAhead(app, 'node_modules/tool/a.js', (await installer.file(app, 'node_modules/tool/a.js'))!.body, prefetcher, channel), null);
  assert.ok(pushAhead(app, 'node_modules/tool/a.js', (await installer.file(app, 'node_modules/tool/a.js'))!.body, prefetcher, {}));
});

test('push: only over a file channel, and only for an install with a prefetch (never run)', async () => {
  // No channel (HTTP): a plain answer.
  const out = await serve({ method: 'GET', path: `/__sandburg/nm/${key}/t/node_modules/other/index.js`, query: new URLSearchParams('ahead=1'), body: async () => Buffer.alloc(0) } as HostRequest);
  assert.equal(out?.status, 200);
  // A channel, but no prefetcher for this install: a plain answer.
  const viaChannel = await serve({ method: 'GET', path: `/__sandburg/nm/${key}/t/node_modules/other/index.js`, query: new URLSearchParams('ahead=1'), body: async () => Buffer.alloc(0), channel: {} } as HostRequest);
  assert.equal(viaChannel?.status, 200);
});
