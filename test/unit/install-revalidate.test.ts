/**
 * Installs removed while the process keeps running (.sandburg cleared between sessions, issue #117):
 * what the process kept of them is not trusted, and they are installed again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Installer, recordIdentity, recordLayout, recordOf, sideInstall } from '../../src/adapters/node/install.ts';
import { Resolver } from '../../src/adapters/node/resolver.ts';
import { COMPILER, CompileCache } from '../../src/adapters/node/compile-cache.ts';
import { ESM_MARKER } from '../../src/node-runtime/names.ts';
import type { Project } from '../../src/types.ts';
import { tempDir } from './temp-dir.ts';

// No dependencies: npm resolves an empty tree, without the registry.
const project = (name: string) => ({ files: { 'package.json': JSON.stringify({ name }) }, packageJson: { name } }) as unknown as Project;

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

test('an install removed from disk is installed again, not answered from memory', async () => {
  const installer = new Installer(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('removed'), {}, () => {});
  assert.equal(first.fromCache, false);
  assert.equal((await installer.install(project('removed'), {}, () => {})).dir, first.dir);
  rmSync(first.dir, { recursive: true, force: true });
  const again = await installer.install(project('removed'), {}, () => {});
  assert.equal(again.key, first.key);
  assert.equal(again.fromCache, false);
  assert.ok(existsSync(join(again.dir, '.sandburg-complete')));
  assert.deepEqual(await installer.index(again.key), { 'node_modules/.sandburg-bins.json': 2 });
});

test('a whole store removed (.sandburg cleared): installs are made again in it', async () => {
  const root = tempDir('sandburg-revalidate-');
  const installer = new Installer(join(root, '.sandburg', 'installs'));
  const first = await installer.install(project('cleared'), {}, () => {});
  rmSync(join(root, '.sandburg'), { recursive: true, force: true });
  const again = await installer.install(project('cleared'), {}, () => {});
  assert.equal(again.fromCache, false);
  assert.ok(existsSync(join(first.dir, '.sandburg-complete')));
});

test('only the completion record gone is enough to install again', async () => {
  const installer = new Installer(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('unfinished'), {}, () => {});
  rmSync(join(first.dir, '.sandburg-complete'));
  // The directory without its record is replaced (settle), as one an older version left.
  const again = await installer.install(project('unfinished'), {}, () => {});
  assert.equal(again.fromCache, false);
  assert.ok(existsSync(join(again.dir, '.sandburg-complete')));
});

test("an install removed and made again by another process: this one's transforms, types and index of it are dropped", async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { key, dir } = await new Installer(installs).install(project('remade'), {}, () => {});
  // Files added to the finished install, its index to be walked again: an ES module package.
  write(dir, { 'node_modules/p/package.json': '{"name":"p","type":"module"}', 'node_modules/p/index.js': 'export default "first";' });
  rmSync(join(dir, '.sandburg-index.json'));

  const installer = new Installer(installs);
  const forgotten: string[] = [];
  installer.onForget((k) => forgotten.push(k));
  assert.equal((await installer.install(project('remade'), {}, () => {})).fromCache, true);
  const combined = installer.combine([{ dir: '', key }]);
  const before = (await installer.file(key, 'node_modules/p/index.js'))!.body.toString();
  assert.ok(before.includes('first') && before.startsWith(ESM_MARKER));

  // Another process removes the install and makes it again, now with a CommonJS package.
  rmSync(dir, { recursive: true, force: true });
  await new Installer(installs).install(project('remade'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = "second";' });
  rmSync(join(dir, '.sandburg-index.json'));

  // Its record is another: the install (and the combined key that has it) is forgotten.
  assert.equal((await installer.install(project('remade'), {}, () => {})).fromCache, true);
  assert.deepEqual(forgotten, [key, combined]);
  const after = (await installer.file(key, 'node_modules/p/index.js'))!.body.toString();
  assert.ok(after.includes('second'), after);
  assert.ok(!after.startsWith(ESM_MARKER), 'the package type is read again');
  assert.ok('node_modules/p/index.js' in (await installer.index(key)));
});

test('an install removed and made again here: a transform remembered of a file it no longer has is not served', async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { dir } = await new Installer(installs).install(project('gone-file'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = 1;' });
  rmSync(join(dir, '.sandburg-index.json'));
  const installer = new Installer(installs);
  const { key } = await installer.install(project('gone-file'), {}, () => {});
  assert.ok(await installer.file(key, 'node_modules/p/index.js'));
  assert.ok(installer.remembered(key, 'node_modules/p/index.js'));
  rmSync(dir, { recursive: true, force: true });
  assert.equal((await installer.install(project('gone-file'), {}, () => {})).fromCache, false);
  assert.equal(installer.remembered(key, 'node_modules/p/index.js'), undefined);
  assert.equal(await installer.file(key, 'node_modules/p/index.js'), null);
});

test('installs at once after a removal start one install', async () => {
  const installer = new Installer(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('together'), {}, () => {});
  rmSync(first.dir, { recursive: true, force: true });
  const [a, b] = await Promise.all([installer.install(project('together'), {}, () => {}), installer.install(project('together'), {}, () => {})]);
  assert.equal(a, b);
  assert.equal(a.fromCache, false);
});

test('a side install removed from disk is installed again', async () => {
  const root = tempDir('sandburg-revalidate-');
  const sides = { root: join(root, 'side-installs'), store: join(root, 'store'), resolver: new Resolver(join(root, 'installs'), ['--ignore-scripts']), recordOf };
  const manifest = { name: 'sandburg-side-test', private: true, dependencies: {} };
  const dir = await sideInstall(sides, manifest, ['--ignore-scripts'], () => {});
  assert.ok(existsSync(join(dir, '.sandburg-complete')));
  assert.equal(await sideInstall(sides, manifest, ['--ignore-scripts'], () => {}), dir);
  rmSync(sides.root, { recursive: true, force: true });
  assert.equal(await sideInstall(sides, manifest, ['--ignore-scripts'], () => {}), dir);
  assert.ok(existsSync(join(dir, '.sandburg-complete')));
});

test("a project's compiles kept in memory are written again once their file is removed", async () => {
  const dir = tempDir('sandburg-revalidate-');
  const key = 'f'.repeat(24);
  const file = join(dir, `compiled-${COMPILER}-${key}.bin`);
  const cache = new CompileCache(() => dir);
  await cache.record(key, 'cjs', false, '/[eval]', 'module.exports = 1;', 'compiled');
  await cache.flush();
  assert.ok(existsSync(file));
  rmSync(dir, { recursive: true, force: true });
  // Still true (each is the output for its code), and written back.
  assert.equal(await cache.has(key), true);
  await cache.flush();
  assert.ok(existsSync(file));
  // Read by a later cache from that file: the same compiles.
  const later = new CompileCache(() => dir);
  assert.equal(await later.has(key), true);
  assert.equal((await later.bundle(key))?.equals((await cache.bundle(key))!), true);
});

test("a combined key keeps its parts when one is installed again: it is served from the part's new install", async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { key, dir } = await new Installer(installs).install(project('combined'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = "first";' });
  rmSync(join(dir, '.sandburg-index.json'));
  const installer = new Installer(installs);
  await installer.install(project('combined'), {}, () => {});
  // A run of a project with a client/ package holds the combined key.
  const combined = installer.combine([{ dir: 'client', key }]);
  assert.match((await installer.file(combined, 'client/node_modules/p/index.js'))!.body.toString(), /first/);

  rmSync(dir, { recursive: true, force: true });
  await new Installer(installs).install(project('combined'), {}, () => {});
  write(dir, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = "second";', 'node_modules/p/raw.txt': 'raw' });
  rmSync(join(dir, '.sandburg-index.json'));
  await installer.install(project('combined'), {}, () => {});

  assert.match((await installer.file(combined, 'client/node_modules/p/index.js'))!.body.toString(), /second/);
  assert.equal((await installer.raw(combined, 'client/node_modules/p/raw.txt'))?.body.toString(), 'raw');
  assert.ok('client/node_modules/p/raw.txt' in (await installer.index(combined)));
});

test('a record\'s identity keeps file IDs above 2^53 and nanosecond times apart, and works without inode numbers', () => {
  const base = { dev: 2049n, ino: 2n ** 53n, size: 36n, mtimeNs: 1_761_730_000_000_000_001n, birthtimeNs: 1_761_730_000_000_000_001n };
  assert.notEqual(recordIdentity(base), recordIdentity({ ...base, ino: 2n ** 53n + 1n }));
  assert.notEqual(recordIdentity(base), recordIdentity({ ...base, mtimeNs: base.mtimeNs + 1n }));
  // No inode numbers (0 on some file systems): a record made again still differs by its times.
  assert.notEqual(recordIdentity({ ...base, ino: 0n }), recordIdentity({ ...base, ino: 0n, mtimeNs: base.mtimeNs + 1n, birthtimeNs: base.birthtimeNs + 1n }));
  assert.equal(recordIdentity(base), recordIdentity({ ...base }));
});

/** An Installer whose first record is taken after the install's .sandburg-complete was removed (.sandburg cleared during a run). */
class ClearedWhileRecording extends Installer {
  private cleared = false;
  protected override recordOf(dir: string): Promise<string | null | undefined> {
    if (!this.cleared) {
      this.cleared = true;
      rmSync(dir, { recursive: true, force: true });
    }
    return super.recordOf(dir);
  }
}

test('an install whose record is gone before it is taken is checked again when asked for, and made again', async () => {
  const installer = new ClearedWhileRecording(join(tempDir('sandburg-revalidate-'), 'installs'));
  const first = await installer.install(project('cleared-early'), {}, () => {});
  assert.equal(existsSync(first.dir), false);
  const again = await installer.install(project('cleared-early'), {}, () => {});
  assert.notEqual(again, first);
  assert.ok(existsSync(join(again.dir, '.sandburg-complete')));
  // And then answered from memory, while its record stays.
  assert.equal(await installer.install(project('cleared-early'), {}, () => {}), again);
});

test('a side install whose record is gone before it is taken is made again when asked for', async () => {
  const root = tempDir('sandburg-revalidate-');
  let cleared = false;
  const sides = {
    root: join(root, 'side-installs'),
    store: join(root, 'store'),
    resolver: new Resolver(join(root, 'installs'), ['--ignore-scripts']),
    recordOf: (dir: string) => {
      if (!cleared) {
        cleared = true;
        rmSync(dir, { recursive: true, force: true });
      }
      return recordOf(dir);
    },
  };
  const manifest = { name: 'sandburg-side-early', private: true, dependencies: {} };
  const dir = await sideInstall(sides, manifest, ['--ignore-scripts'], () => {});
  assert.equal(existsSync(dir), false);
  assert.equal(await sideInstall(sides, manifest, ['--ignore-scripts'], () => {}), dir);
  assert.ok(existsSync(join(dir, '.sandburg-complete')));
});

test('side installs of Installers on other roots are each their own', async () => {
  const manifest = { name: 'sandburg-side-roots', private: true, dependencies: {} };
  // Records taken, per root: one when a side install is made, one each time it is asked for again.
  const sidesOf = (root: string) => {
    const sides = { root: join(root, 'side-installs'), store: join(root, 'store'), resolver: new Resolver(join(root, 'installs'), ['--ignore-scripts']), taken: 0, recordOf: (dir: string) => (sides.taken++, recordOf(dir)) };
    return sides;
  };
  const [a, b] = [sidesOf(tempDir('sandburg-revalidate-')), sidesOf(tempDir('sandburg-revalidate-'))];
  const inA = await sideInstall(a, manifest, ['--ignore-scripts'], () => {});
  const inB = await sideInstall(b, manifest, ['--ignore-scripts'], () => {});
  assert.ok(inA.startsWith(a.root) && inB.startsWith(b.root) && existsSync(join(inB, '.sandburg-complete')));
  // Asked for again, alternately: each is answered from memory after one record, not made again.
  for (let i = 0; i < 3; i++) {
    assert.equal(await sideInstall(a, manifest, ['--ignore-scripts'], () => {}), inA);
    assert.equal(await sideInstall(b, manifest, ['--ignore-scripts'], () => {}), inB);
  }
  assert.deepEqual([a.taken, b.taken], [4, 4]);
});

test("a record is told by its id, not by the file system's inode numbers or times", () => {
  const dir = tempDir('sandburg-revalidate-');
  const file = join(dir, '.sandburg-complete');
  writeFileSync(file, `2026-10-29T00:00:00.000Z layout 17 record ${'a'.repeat(32)}\n`);
  const { atime, mtime } = statSync(file);
  return (async () => {
    const first = await recordOf(dir);
    assert.equal(first, `record:${'a'.repeat(32)}`);
    // Made again with the same inode, size and times (inode reuse, coarse times): another id.
    writeFileSync(file, `2026-10-29T00:00:00.000Z layout 17 record ${'b'.repeat(32)}\n`);
    utimesSync(file, atime, mtime);
    assert.notEqual(await recordOf(dir), first);
    // The same record with other times (an unstable stat): the same.
    writeFileSync(file, `2026-10-29T00:00:00.000Z layout 17 record ${'a'.repeat(32)}\n`);
    utimesSync(file, new Date(0), new Date(0));
    assert.equal(await recordOf(dir), first);
    rmSync(file);
    assert.equal(await recordOf(dir), null);
  })();
});

test("an older version's record (no id) is told by its stat, and its install is used as it is", async () => {
  const installs = join(tempDir('sandburg-revalidate-'), 'installs');
  const { dir } = await new Installer(installs).install(project('older'), {}, () => {});
  writeFileSync(join(dir, '.sandburg-complete'), '2026-01-01T00:00:00.000Z layout 17\n');
  assert.match((await recordOf(dir))!, /^stat:/);
  assert.equal(await recordOf(dir), await recordOf(dir));
  const installer = new Installer(installs);
  const forgotten: string[] = [];
  installer.onForget((k) => forgotten.push(k));
  const info = await installer.install(project('older'), {}, () => {});
  assert.equal(info.fromCache, true);
  assert.equal(await installer.install(project('older'), {}, () => {}), info);
  assert.deepEqual(forgotten, []);
  // Removed: made again, with an id.
  rmSync(dir, { recursive: true, force: true });
  assert.equal((await installer.install(project('older'), {}, () => {})).fromCache, false);
  assert.match((await recordOf(dir))!, /^record:/);
});

/** A file system error with `code`, as fs/promises rejects with. */
const failing = (code: string) => () => Promise.reject(Object.assign(new Error(`${code}: simulated`), { code }));

test("a record that cannot be read (EMFILE, EACCES) is not taken for a removed one; one that is not there is", async () => {
  const dir = tempDir('sandburg-revalidate-');
  writeFileSync(join(dir, '.sandburg-complete'), `2026-10-29T00:00:00.000Z layout 17 record ${'c'.repeat(32)}\n`);
  assert.equal(await recordOf(dir), `record:${'c'.repeat(32)}`);
  // Not told: the read fails, and the stat fails too or says it is there.
  assert.equal(await recordOf(dir, { readFile: failing('EMFILE'), stat: failing('EMFILE') }), undefined);
  assert.equal(await recordOf(dir, { readFile: failing('EMFILE'), stat }), undefined);
  assert.equal(await recordOf(dir, { readFile: failing('EACCES'), stat }), undefined);
  assert.equal(await recordOf(dir, { readFile, stat: failing('EMFILE') }), `record:${'c'.repeat(32)}`);
  // Gone: the read or the stat says so.
  assert.equal(await recordOf(dir, { readFile: failing('ENOENT'), stat }), null);
  assert.equal(await recordOf(dir, { readFile: failing('EMFILE'), stat: failing('ENOENT') }), null);
  assert.equal(await recordOf(dir, { readFile: failing('ENOTDIR'), stat }), null);
  // On the file system: a directory in its place cannot be read, and is there; a file above it means none.
  rmSync(join(dir, '.sandburg-complete'));
  mkdirSync(join(dir, '.sandburg-complete'));
  assert.equal(await recordOf(dir), undefined);
  writeFileSync(join(dir, 'file'), '');
  assert.equal(await recordOf(join(dir, 'file')), null);
});

/** An Installer whose records cannot be read while `busy` (EMFILE), as on a busy host. */
class Busy extends Installer {
  busy = false;
  protected override recordOf(dir: string): Promise<string | null | undefined> {
    return this.busy ? recordOf(dir, { readFile: failing('EMFILE'), stat: failing('EMFILE') }) : super.recordOf(dir);
  }
}

test('an install whose record cannot be read is used as it is, not forgotten or made again; one removed still is', async () => {
  const installer = new Busy(join(tempDir('sandburg-revalidate-'), 'installs'));
  const forgotten: string[] = [];
  installer.onForget((k) => forgotten.push(k));
  const first = await installer.install(project('busy'), {}, () => {});
  installer.busy = true;
  assert.equal(await installer.install(project('busy'), {}, () => {}), first);
  installer.busy = false;
  assert.equal(await installer.install(project('busy'), {}, () => {}), first);
  assert.deepEqual(forgotten, []);
  rmSync(first.dir, { recursive: true, force: true });
  const again = await installer.install(project('busy'), {}, () => {});
  assert.equal(again.fromCache, false);
  assert.deepEqual(forgotten, [first.key]);
});

test('an install whose record cannot be read when it finishes keeps the record read later, and is still checked', async () => {
  const installer = new Busy(join(tempDir('sandburg-revalidate-'), 'installs'));
  installer.busy = true;
  const first = await installer.install(project('busy-early'), {}, () => {});
  installer.busy = false;
  // Read now: kept, not a reason to install again.
  assert.equal(await installer.install(project('busy-early'), {}, () => {}), first);
  assert.equal(await installer.install(project('busy-early'), {}, () => {}), first);
  // And a removal after that is seen.
  rmSync(first.dir, { recursive: true, force: true });
  assert.equal((await installer.install(project('busy-early'), {}, () => {})).fromCache, false);
});

test("a record's layout is its number, not a prefix of a longer one", () => {
  assert.equal(recordLayout('2026-10-29T00:00:00.000Z layout 17 record x\n'), 17);
  assert.equal(recordLayout('2026-10-29T00:00:00.000Z layout 170\n'), 170);
  assert.equal(recordLayout('layout x\n'), null);
  assert.equal(recordLayout(''), null);
});
