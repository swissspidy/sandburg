import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSoon } from '../../src/adapters/node/file-writes.ts';

test('writeSoon writes each file whole, in directories it makes, and does not wait for the write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-writes-'));
  const files = Array.from({ length: 200 }, (_, i) => join(root, (i % 16).toString(16).padStart(2, '0'), `f${i}.js`));
  const writes = files.map((f, i) => writeSoon(f, i % 2 ? `text ${i}` : Buffer.from(`bytes ${i}`)));
  // Each call returns before its write is made: its promise is still pending in the turn that asked.
  const PENDING = Symbol('pending');
  assert.equal(await Promise.race([writes[0], Promise.resolve(PENDING)]), PENDING);
  assert.deepEqual(await Promise.all(writes), files.map(() => true));
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
