import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// The synchronous fs calls a write makes (writeNow), counted on this (the main) thread: they are the
// writer thread's to make. Set before file-writes.ts is loaded, its named imports bound to the spies.
const SYNC_CALLS = ['writeFileSync', 'renameSync', 'mkdirSync', 'rmSync'] as const;
const originals = Object.fromEntries(SYNC_CALLS.map((name) => [name, fs[name]])) as Record<(typeof SYNC_CALLS)[number], (...a: unknown[]) => unknown>;
let mainThreadCalls = 0;
for (const name of SYNC_CALLS) (fs as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => ((mainThreadCalls++), originals[name](...a));
syncBuiltinESMExports();
const { writeSoon } = await import('../../src/adapters/node/file-writes.ts');
after(() => {
  for (const name of SYNC_CALLS) (fs as unknown as Record<string, unknown>)[name] = originals[name];
  syncBuiltinESMExports();
});

test('writeSoon writes each file whole, in directories it makes, and does not wait for the write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandburg-writes-'));
  const files = Array.from({ length: 200 }, (_, i) => join(root, (i % 16).toString(16).padStart(2, '0'), `f${i}.js`));
  const writes = files.map((f, i) => writeSoon(f, i % 2 ? `text ${i}` : Buffer.from(`bytes ${i}`)));
  // Each call returns before its write is made: its promise is still pending in the turn that asked.
  const PENDING = Symbol('pending');
  assert.equal(await Promise.race([writes[0], Promise.resolve(PENDING)]), PENDING);
  assert.deepEqual(await Promise.all(writes), files.map(() => true));
  // None of it on this thread (a write made here, even one that settles its promise later, counts).
  assert.equal(mainThreadCalls, 0);
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
