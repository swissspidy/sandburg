import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './temp-dir.ts';
import type { HostResponse } from '../../src/types.ts';

// The node adapter serves from the shared installer, rooted here (set before it is loaded).
const root = tempDir('sandburg-pages-record-');
process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
const { serve } = await import('../../src/adapters/node/index.ts');
const { recordingServe } = await import('../../scripts/pages/record.ts');

const key = 'd'.repeat(24);
const files: Record<string, string> = {
  'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' }),
  'node_modules/dep/a.js': 'module.exports = "a";',
  'node_modules/dep/b.js': 'module.exports = "b";',
};
for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(join(root, 'installs', key, path)), { recursive: true });
  writeFileSync(join(root, 'installs', key, path), content);
}

const channel = {};
const get = (rel: string, query: string, over?: object) => ({ method: 'GET', path: `/__sandburg/nm/${key}/f/${rel}`, query: new URLSearchParams(query), body: async () => Buffer.alloc(0), channel: over });

function recorder() {
  const recorded = new Map<string, HostResponse>();
  return { recorded, serve: recordingServe(serve, async (k, res) => void recorded.set(k, res)) };
}

test('pages recording: a read-ahead over the file channel is recorded as the file a plain GET answers', async () => {
  const { recorded, serve: recording } = recorder();
  const res = await recording(get('node_modules/dep/a.js', 'ahead=1', channel));
  // The runtime gets the read-ahead bundle; a demo, asking without a channel, gets the file.
  assert.equal(res?.status, 207);
  const entry = recorded.get(`/__sandburg/nm/${key}/f/node_modules/dep/a.js`);
  assert.equal(entry?.status, 200);
  assert.equal(Buffer.from(entry.body).toString(), files['node_modules/dep/a.js']);
});

test('pages recording: a note that a file sent ahead was read does not replace the file', async () => {
  const { recorded, serve: recording } = recorder();
  await recording(get('node_modules/dep/b.js', '', undefined));
  const note = await recording(get('node_modules/dep/b.js', 'used=1', channel));
  assert.equal(note?.status, 204);
  const entry = recorded.get(`/__sandburg/nm/${key}/f/node_modules/dep/b.js`);
  assert.equal(entry?.status, 200);
  assert.equal(Buffer.from(entry.body).toString(), files['node_modules/dep/b.js']);
});

test('pages recording: a file only noted as read (it came in a read-ahead) is recorded too', async () => {
  const { recorded, serve: recording } = recorder();
  await recording(get('node_modules/dep/package.json', 'used=1', channel));
  const entry = recorded.get(`/__sandburg/nm/${key}/f/node_modules/dep/package.json`);
  assert.equal(entry?.status, 200);
  assert.equal(Buffer.from(entry.body).toString(), files['node_modules/dep/package.json']);
});

test('pages recording: a plain GET is recorded as answered, a missing file not at all', async () => {
  const { recorded, serve: recording } = recorder();
  await recording(get('node_modules/dep/a.js', '', undefined));
  assert.equal(recorded.get(`/__sandburg/nm/${key}/f/node_modules/dep/a.js`)?.status, 200);
  const missing = await recording(get('node_modules/dep/none.js', 'ahead=1', channel));
  assert.equal(missing, null);
  assert.equal(recorded.has(`/__sandburg/nm/${key}/f/node_modules/dep/none.js`), false);
});
