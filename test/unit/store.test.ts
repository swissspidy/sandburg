import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotStore, manifestOf, snapshotId } from '../../src/store.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';

test('snapshot ids depend on content only, not order or name', () => {
  const a = snapshotId(manifestOf({ 'a.txt': 'A', 'b.txt': 'B' }));
  const b = snapshotId(manifestOf({ 'b.txt': 'B', 'a.txt': 'A' }));
  assert.equal(a, b);
  assert.notEqual(a, snapshotId(manifestOf({ 'a.txt': 'A', 'b.txt': 'b' })));
  assert.notEqual(a, snapshotId(manifestOf({ 'a.txt': 'A', 'c.txt': 'B' })));
  // String and base64 forms of the same bytes are the same blob.
  assert.equal(snapshotId(manifestOf({ x: 'hi' })), snapshotId(manifestOf({ x: { base64: Buffer.from('hi').toString('base64') } })));
});

test('store round-trips files, dedupes, resolves prefixes and detects corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-store-'));
  try {
    const store = new SnapshotStore(root);
    const files = { 'index.html': '<h1>x</h1>', 'img.bin': { base64: Buffer.from([0, 1, 2, 255]).toString('base64') } };
    const id = await store.put(files, 'demo');
    assert.equal(await store.put(files, 'renamed'), id);
    assert.equal(id, projectFromFiles(files, { name: 'x', path: 'x' }).snapshotId);

    const { record, files: back } = await store.get(id.slice(0, 10));
    assert.equal(record.name, 'demo');
    assert.deepEqual(back, files);

    const project = await loadProject(`snapshot:${id.slice(0, 12)}`, store);
    assert.equal(project.snapshotId, id);

    await writeFile(join(root, 'blobs', record.files['index.html'].slice(0, 2), record.files['index.html']), 'tampered');
    await assert.rejects(store.get(id), /corrupt blob/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
