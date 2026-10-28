import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

test("npm's script is found beside an npm.cmd on PATH, in PATH's order, when neither of the others is there", () => {
  const dir = tempDir('sandburg-npm-path-');
  const node = join(dir, 'nodejs', 'node.exe');
  const shim = (name: string, withCli: boolean) => {
    const bin = join(dir, name);
    mkdirSync(join(bin, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(bin, 'npm.cmd'), '');
    if (withCli) writeFileSync(join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    return bin;
  };
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  // A shim without npm beside it (a version manager's) is passed over; then the first that has it.
  const volta = shim('volta', false);
  const scoop = shim('scoop', true);
  const other = shim('other', true);
  const PATH = ['', empty, volta, scoop, other].join(delimiter);
  assert.equal(npmCliScript({ PATH }, node), join(scoop, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  // Windows' own spelling, in a copy of the environment.
  assert.equal(npmCliScript({ Path: PATH }, node), join(scoop, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.equal(npmCliScript({ PATH: [empty, volta].join(delimiter) }, node), null);
});

test('on Windows with no npm-cli.js anywhere, spawning npm fails with what was looked for and how to fix it', () => {
  const { execPath } = process;
  process.execPath = join(tempDir('sandburg-npm-none-'), 'node.exe');
  // Key by key (on Windows, process.env's keys are case-insensitive; a copy's are not).
  const saved = { npm_execpath: process.env.npm_execpath, PATH: process.env.PATH };
  try {
    delete process.env.npm_execpath;
    process.env.PATH = '';
    assert.throws(() => npmCommand(['view', 'x'], 'win32'), /^Error: npm not found: no npm-cli\.js at npm_execpath, beside node\.exe .* set npm_execpath to npm-cli\.js, or install npm beside node\.exe\.$/);
  } finally {
    process.execPath = execPath;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
