import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeSoon } from '../../src/adapters/node/file-writes.ts';

test('writeSoon writes each file whole, in directories it makes, after the current turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-writes-'));
  const files = Array.from({ length: 200 }, (_, i) => join(root, (i % 16).toString(16).padStart(2, '0'), `f${i}.js`));
  let written = false;
  const all = Promise.all(files.map((f, i) => writeSoon(f, i % 2 ? `text ${i}` : Buffer.from(`bytes ${i}`))));
  void Promise.resolve().then(() => (written = true));
  // Nothing is written in the turn that asked (the answers go out first).
  assert.equal(existsSync(files[0]), false);
  assert.deepEqual(await all, files.map(() => true));
  assert.ok(written);
  for (const [i, f] of files.entries()) assert.equal(await readFile(f, 'utf8'), i % 2 ? `text ${i}` : `bytes ${i}`);
  // No temporary file is left.
  for (const dir of await readdir(root)) assert.ok((await readdir(join(root, dir))).every((n) => !n.endsWith('.tmp')));
  await rm(root, { recursive: true, force: true });
});

test('a write that cannot be made resolves false and leaves nothing; a directory removed since is made again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-writes-'));
  // A file where a directory should be.
  await writeFile(join(root, 'blocked'), '');
  assert.equal(await writeSoon(join(root, 'blocked', 'a.js'), 'x'), false);
  assert.deepEqual(await readdir(root), ['blocked']);
  // A directory made, then removed (a sweep): made again.
  const file = join(root, 'aa', 'b.js');
  assert.equal(await writeSoon(file, 'one'), true);
  await rm(join(root, 'aa'), { recursive: true });
  assert.equal(await writeSoon(file, 'two'), true);
  assert.equal(await readFile(file, 'utf8'), 'two');
  await rm(root, { recursive: true, force: true });
});
