/** The app's files a run collects and --save-files writes (src/orchestrator/app-files.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFilePathProblem, appFilesFrom, renameRetrying, writeAppFiles } from '../../src/orchestrator/app-files.ts';
import { tempDir } from './temp-dir.ts';

test('only paths that match the pattern are kept, whatever else the page returned', () => {
  const { files } = appFilesFrom({ 'notes.db': { base64: 'AA==' }, 'server/db.js': 'x', 'data/app.db': 'y' }, String.raw`\.db$`);
  assert.deepEqual(files, { 'notes.db': { base64: 'AA==' }, 'data/app.db': 'y' });
});

test('absolute, Windows and non-normalized paths are refused', () => {
  for (const path of ['', '/etc/x.db', '//x.db', 'a\\b.db', '..\\x.db', 'C:x.db', 'c:/x.db', 'a:b.db', 'notes.db:stream', 'a\0.db', '.', '..', '../x.db', 'a/../../x.db', './x.db', 'a/./x.db', 'a//x.db', 'a/', 'a/..']) {
    assert.notEqual(appFilePathProblem(path), null, path);
  }
  assert.deepEqual(appFilesFrom({ '../x.db': 'a', '/x.db': 'b', 'a\\x.db': 'c', 'a//x.db': 'd' }, '').files, {});
});

test('.git and node_modules, in any case and at any depth, and dot directories are refused', () => {
  for (const path of ['.git', '.git/config', '.GIT/hooks/pre-commit', 'sub/.Git/config', 'sub/.git', 'node_modules/x/x.db', 'Node_Modules/x/x.db', '.cache/x.db', 'a/.hidden/x.db']) {
    assert.notEqual(appFilePathProblem(path), null, path);
  }
  for (const path of ['notes.db', 'data/notes.db', '.env', 'data/.notes.db', 'git/x.db', '.gitignore']) assert.equal(appFilePathProblem(path), null, path);
});

test('names some file systems read as another are refused: trailing dots and spaces, 8.3 short names', () => {
  for (const path of ['.git.', '.git ', 'notes.db.', 'notes.db ', 'data./x.db', 'data /x.db', 'GIT~1/config', 'data/NOTES~1.DB', 'x~2']) {
    assert.notEqual(appFilePathProblem(path), null, path);
  }
  for (const path of ['notes~.db', 'a~b.db', 'v1.2/x.db']) assert.equal(appFilePathProblem(path), null, path);
});

test('entries that are not file contents are dropped, and a value that is not a tree is empty', () => {
  assert.deepEqual(appFilesFrom({ 'a.db': 1, 'b.db': { base64: 2 }, 'c.db': null, 'd.db': 'ok' }, '').files, { 'd.db': 'ok' });
  assert.deepEqual(appFilesFrom(null, ''), { files: {} });
  assert.deepEqual(appFilesFrom('a.db', ''), { files: {} });
});

test('a "__proto__" path is a file like any other, not the tree\'s prototype', () => {
  const { files } = appFilesFrom(JSON.parse('{"__proto__": "x"}'), '');
  assert.equal(Object.getPrototypeOf(files), Object.prototype);
  assert.deepEqual(Object.keys(files), ['__proto__']);
});

test('over a limit, none of the files, and why: files, bytes in all, entries looked at', () => {
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.db`, 'x']));
  assert.deepEqual(appFilesFrom(many, '', { files: 5, bytes: 100 }).files, many);
  assert.deepEqual(appFilesFrom(many, '', { files: 3, bytes: 100 }), { files: {}, refused: '5 files match, more than 3' });
  // Only what matches counts: a -wal journal is never left behind by a cut-off.
  assert.equal(Object.keys(appFilesFrom({ ...many, 'big.txt': 'x'.repeat(50) }, String.raw`\.db$`, { files: 5, bytes: 10 }).files).length, 5);
  assert.deepEqual(appFilesFrom({ 'a.db': 'xxxx', 'a.db-wal': { base64: 'AAAA' } }, '', { files: 10, bytes: 6 }), { files: {}, refused: '7 bytes match, more than 6' });
  const lots = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`${i}.txt`, 'x']));
  assert.deepEqual(appFilesFrom(lots, String.raw`\.db$`, { files: 3, bytes: 100 }), { files: {}, refused: 'more than 30 entries' });
});

test('a path longer than 4096 characters is not matched against the pattern', () => {
  let tested = 0;
  const pattern = String.raw`(?:)`;
  const RealRegExp = RegExp;
  const counting = class extends RealRegExp {
    override test(s: string) {
      tested++;
      return super.test(s);
    }
  };
  globalThis.RegExp = counting as RegExpConstructor;
  try {
    const { files } = appFilesFrom({ ['a'.repeat(4097)]: 'x', 'ok.db': 'y' }, pattern);
    assert.deepEqual(files, { 'ok.db': 'y' });
    assert.equal(tested, 1);
  } finally {
    globalThis.RegExp = RealRegExp;
  }
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
  assert.deepEqual(skipped.map((s) => s.reason), ['invalid path', 'invalid path', 'invalid path']);
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
  assert.deepEqual(skipped, [
    { path: 'data/x.db', reason: 'symlink' },
    { path: 'notes.db', reason: 'symlink' },
    { path: 'sub/linked/deeper/z.db', reason: 'symlink' },
  ]);
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
  assert.deepEqual(await writeAppFiles(root, { 'notes.db': 'new', 'dir.db': 'x' }), [{ path: 'dir.db', reason: 'not a regular file' }]);
  assert.equal(await readFile(join(outside, 'target.db'), 'utf8'), 'kept');
  assert.equal(await readFile(join(root, 'notes.db'), 'utf8'), 'new');
});

test("a file that is replaced keeps its mode; one that fails to be written is skipped with its error, and the rest are written", async () => {
  const root = tempDir('sandburg-app-files-');
  await writeFile(join(root, 'notes.db'), 'old');
  await chmod(join(root, 'notes.db'), 0o640);
  // 0o640 (Windows has only a read-only bit: 0o666).
  const mode = (await stat(join(root, 'notes.db'))).mode & 0o7777;
  await writeFile(join(root, 'file'), 'a file, where a directory goes');
  const long = `${'n'.repeat(300)}.db`;
  const skipped = await writeAppFiles(root, { 'file/x.db': 'x', [long]: 'too long a name', 'notes.db': 'new', 'b.db': 'b' });
  assert.deepEqual(skipped, [
    { path: 'file/x.db', reason: 'not a directory' },
    // The system's own error: Windows reports a name over 255 characters as not found.
    { path: long, reason: process.platform === 'win32' ? 'ENOENT' : 'ENAMETOOLONG' },
  ]);
  assert.equal(await readFile(join(root, 'notes.db'), 'utf8'), 'new');
  assert.equal((await stat(join(root, 'notes.db'))).mode & 0o7777, mode);
  if (process.platform !== 'win32') assert.equal(mode, 0o640);
  assert.equal(await readFile(join(root, 'b.db'), 'utf8'), 'b');
  // No temporary file left behind.
  assert.deepEqual((await readdir(root)).sort(), ['b.db', 'file', 'notes.db']);
});

test('an invalid collectFiles pattern fails run() before the run starts', async () => {
  const { Session } = await import('../../src/orchestrator/session.ts');
  await assert.rejects(new Session().run('no-such-project', { collectFiles: '(' }), /^Error: collectFiles: Invalid regular expression/);
});

test('a rename that fails while the file is busy is tried again, three times; other errors are not', async () => {
  const failing = (codes: string[]) => {
    const calls: string[] = [];
    const rename = async (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      const code = codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
    };
    return { calls, rename };
  };
  const twice = failing(['EPERM', 'EBUSY']);
  await renameRetrying('t', 'f', twice.rename);
  assert.equal(twice.calls.length, 3);
  const always = failing(['EACCES', 'EACCES', 'EACCES', 'EACCES', 'EACCES']);
  await assert.rejects(renameRetrying('t', 'f', always.rename), { code: 'EACCES' });
  assert.equal(always.calls.length, 4);
  const other = failing(['ENOENT']);
  await assert.rejects(renameRetrying('t', 'f', other.rename), { code: 'ENOENT' });
  assert.equal(other.calls.length, 1);
});
