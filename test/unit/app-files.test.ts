/** The app's files a run collects and --save-files writes (src/orchestrator/app-files.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFilePathProblem, appFilesFrom, writeAppFiles } from '../../src/orchestrator/app-files.ts';
import { tempDir } from './temp-dir.ts';

test('only paths that match the pattern are kept, whatever else the page returned', () => {
  const files = appFilesFrom({ 'notes.db': { base64: 'AA==' }, 'server/db.js': 'x', 'data/app.db': 'y' }, String.raw`\.db$`);
  assert.deepEqual(files, { 'notes.db': { base64: 'AA==' }, 'data/app.db': 'y' });
});

test('absolute, Windows and non-normalized paths are refused', () => {
  for (const path of ['', '/etc/x.db', '//x.db', 'a\\b.db', '..\\x.db', 'C:x.db', 'c:/x.db', 'a\0.db', '.', '..', '../x.db', 'a/../../x.db', './x.db', 'a/./x.db', 'a//x.db', 'a/', 'a/..']) {
    assert.notEqual(appFilePathProblem(path), null, path);
  }
  assert.deepEqual(appFilesFrom({ '../x.db': 'a', '/x.db': 'b', 'a\\x.db': 'c', 'a//x.db': 'd' }, ''), {});
});

test('.git, in any case and at any depth, node_modules and dot directories are refused', () => {
  for (const path of ['.git', '.git/config', '.GIT/hooks/pre-commit', 'sub/.Git/config', 'sub/.git', 'node_modules/x/x.db', '.cache/x.db', 'a/.hidden/x.db']) {
    assert.notEqual(appFilePathProblem(path), null, path);
  }
  for (const path of ['notes.db', 'data/notes.db', '.env', 'data/.notes.db', 'git/x.db', '.gitignore']) assert.equal(appFilePathProblem(path), null, path);
});

test('entries that are not file contents are dropped, and a value that is not a tree is empty', () => {
  assert.deepEqual(appFilesFrom({ 'a.db': 1, 'b.db': { base64: 2 }, 'c.db': null, 'd.db': 'ok' }, ''), { 'd.db': 'ok' });
  assert.deepEqual(appFilesFrom(null, ''), {});
  assert.deepEqual(appFilesFrom('a.db', ''), {});
});

test('a "__proto__" path is a file like any other, not the tree\'s prototype', () => {
  const files = appFilesFrom(JSON.parse('{"__proto__": "x"}'), '');
  assert.equal(Object.getPrototypeOf(files), Object.prototype);
  assert.deepEqual(Object.keys(files), ['__proto__']);
});

test('at most the limits: files, then bytes in all', () => {
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.db`, 'x']));
  assert.deepEqual(Object.keys(appFilesFrom(many, '', { files: 3, bytes: 100 })), ['0.db', '1.db', '2.db']);
  assert.deepEqual(Object.keys(appFilesFrom({ 'a.db': 'xxxx', 'b.db': { base64: 'AAAA' }, 'c.db': 'x' }, '', { files: 10, bytes: 7 })), ['a.db', 'b.db']);
});

test('writes the files under the root, replacing a file that is there', async () => {
  const root = tempDir('sandburg-app-files-');
  await writeFile(join(root, 'notes.db'), 'old');
  const skipped = await writeAppFiles(root, { 'notes.db': 'new', 'data/deep/app.db': { base64: Buffer.from('bytes').toString('base64') } });
  assert.deepEqual(skipped, []);
  assert.equal(await readFile(join(root, 'notes.db'), 'utf8'), 'new');
  assert.equal(await readFile(join(root, 'data/deep/app.db'), 'utf8'), 'bytes');
  assert.deepEqual((await readdir(root)).sort(), ['data', 'notes.db']);
});

test('a path that is not one to write is not written, whoever passed it', async () => {
  const root = tempDir('sandburg-app-files-');
  const outside = tempDir('sandburg-app-files-outside-');
  const skipped = await writeAppFiles(join(root, 'project'), { [`../${outside.split('/').at(-1)}/x.db`]: 'x', '.git/config': 'x', [join(outside, 'y.db')]: 'y' });
  assert.equal(skipped.length, 3);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(root), []);
});

test('nothing is written through a symlink: a linked directory, or a link where the file goes', async () => {
  const root = tempDir('sandburg-app-files-');
  const outside = tempDir('sandburg-app-files-outside-');
  await writeFile(join(outside, 'target.db'), 'kept');
  await symlink(outside, join(root, 'data'));
  await symlink(join(outside, 'target.db'), join(root, 'notes.db'));
  await mkdir(join(root, 'sub'));
  await symlink(outside, join(root, 'sub', 'linked'));
  const skipped = await writeAppFiles(root, { 'data/x.db': 'x', 'notes.db': 'y', 'sub/linked/deeper/z.db': 'z', 'ok.db': 'ok' });
  assert.deepEqual(skipped, ['data/x.db', 'notes.db', 'sub/linked/deeper/z.db']);
  assert.deepEqual(await readdir(outside), ['target.db']);
  assert.equal(await readFile(join(outside, 'target.db'), 'utf8'), 'kept');
  assert.equal(await readFile(join(root, 'ok.db'), 'utf8'), 'ok');
});

test('a hard link where the file goes is replaced, not written through; a directory there is left', async () => {
  const root = tempDir('sandburg-app-files-');
  const outside = tempDir('sandburg-app-files-outside-');
  await writeFile(join(outside, 'target.db'), 'kept');
  await link(join(outside, 'target.db'), join(root, 'notes.db'));
  await mkdir(join(root, 'dir.db'));
  assert.deepEqual(await writeAppFiles(root, { 'notes.db': 'new', 'dir.db': 'x' }), ['dir.db']);
  assert.equal(await readFile(join(outside, 'target.db'), 'utf8'), 'kept');
  assert.equal(await readFile(join(root, 'notes.db'), 'utf8'), 'new');
});
