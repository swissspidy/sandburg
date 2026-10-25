import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Installer } from '../../src/adapters/node/install.ts';
import type { Project } from '../../src/types.ts';

const root = mkdtempSync(join(tmpdir(), 'sandburg-install-index-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** An install on disk (finished unless `complete` is false), as Installer leaves one. */
function install(installs: string, key: string, files: Record<string, string>, complete = true): string {
  const dir = join(installs, key);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  if (complete) writeFileSync(join(dir, '.sandburg-complete'), 'layout x\n');
  return dir;
}

test('install index: a finished install keeps its index beside node_modules; a later process reads it', async () => {
  const installs = join(root, 'a');
  const key = 'a'.repeat(24);
  const dir = install(installs, key, { 'node_modules/p/package.json': '{"name":"p"}', 'node_modules/p/index.js': 'module.exports = 1;' });
  symlinkSync('/etc/passwd', join(dir, 'node_modules/p/link'));
  const expected = { 'node_modules/p/package.json': 12, 'node_modules/p/index.js': 19 };
  assert.deepEqual(await new Installer(installs).index(key), expected);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sandburg-index.json'), 'utf8')), expected);
  // Another process (a new Installer) reads it instead of walking: a file added since is not seen.
  writeFileSync(join(dir, 'node_modules/p/later.js'), '');
  assert.deepEqual(await new Installer(installs).index(key), expected);
});

test('install index: a stored index that names paths outside node_modules is walked again', async () => {
  const installs = join(root, 'b');
  const key = 'b'.repeat(24);
  const dir = install(installs, key, { 'node_modules/p/index.js': 'x' });
  for (const bad of [{ 'node_modules/../../secret': 1 }, { 'package.json': 2 }, { 'node_modules/p/index.js': '1' }, ['node_modules/p/index.js']]) {
    writeFileSync(join(dir, '.sandburg-index.json'), JSON.stringify(bad));
    assert.deepEqual(await new Installer(installs).index(key), { 'node_modules/p/index.js': 1 }, JSON.stringify(bad));
  }
  // And written again, right.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sandburg-index.json'), 'utf8')), { 'node_modules/p/index.js': 1 });
});

test('install index: an unfinished install is walked and nothing is written into it', async () => {
  const installs = join(root, 'c');
  const key = 'c'.repeat(24);
  const dir = install(installs, key, { 'node_modules/p/index.js': 'x' }, false);
  assert.deepEqual(await new Installer(installs).index(key), { 'node_modules/p/index.js': 1 });
  assert.equal(existsSync(join(dir, '.sandburg-index.json')), false);
});

test('install index: an install made here has its index from the start', async () => {
  const installs = join(root, 'd');
  // No dependencies: npm resolves an empty tree, without the registry.
  const project = { files: { 'package.json': '{"name":"indexed"}' }, packageJson: { name: 'indexed' } } as unknown as Project;
  const info = await new Installer(installs).install(project, {}, () => {});
  // Its node_modules has only the commands index the runtime's shell reads.
  assert.deepEqual(JSON.parse(readFileSync(join(info.dir, '.sandburg-index.json'), 'utf8')), { 'node_modules/.sandburg-bins.json': 2 });
});
