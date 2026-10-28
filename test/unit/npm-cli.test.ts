import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { npmCliScript, npmCommand } from '../../src/adapters/node/npm-cli.ts';
import { tempDir } from './temp-dir.ts';

test('npm is spawned as `npm` outside Windows', () => {
  assert.deepEqual(npmCommand(['view', 'x'], 'linux'), ['npm', ['view', 'x']]);
  assert.deepEqual(npmCommand(['view', 'x'], 'darwin'), ['npm', ['view', 'x']]);
});

test('on Windows npm is its npm-cli.js on this node, not npm.cmd (which spawns only through a shell)', { skip: process.platform !== 'win32' && 'npm.cmd is Windows' }, () => {
  const [file, args] = npmCommand(['view', 'x']);
  assert.equal(file, process.execPath);
  assert.match(args[0], /npm-cli\.js$/);
  assert.deepEqual(args.slice(1), ['view', 'x']);
});

test("npm's script is the one that started this process, else the one beside the node binary", () => {
  const dir = tempDir('sandburg-npm-cli-');
  const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(join(cli, '..'), { recursive: true });
  writeFileSync(cli, '');
  const node = join(dir, 'node.exe');
  assert.equal(npmCliScript({}, node), cli);
  const other = join(dir, 'other-npm-cli.js');
  writeFileSync(other, '');
  assert.equal(npmCliScript({ npm_execpath: other }, node), other);
  // Not npm's (pnpm and yarn set npm_execpath too), or not there: the one beside node.
  assert.equal(npmCliScript({ npm_execpath: join(dir, 'pnpm.cjs') }, node), cli);
  assert.equal(npmCliScript({ npm_execpath: join(dir, 'missing', 'npm-cli.js') }, node), cli);
  assert.equal(npmCliScript({}, join(dir, 'elsewhere', 'node.exe')), null);
});
