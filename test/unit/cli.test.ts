/** The command line's options as the session gets them (src/cli.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseCommandLine, sessionOptions } from '../../src/cli.ts';
import { compareExitCode } from '../../src/compare/cli.ts';
import type { ComparePair, Rates } from '../../src/compare/compare.ts';
import { tempDir } from './temp-dir.ts';

const fixture = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));

const options = (...argv: string[]) => {
  const { values, positionals } = parseCommandLine(argv);
  return sessionOptions(values, positionals[0]);
};

test("--no-browser-sandbox turns Chromium's OS sandbox off; without it, the session's default applies", () => {
  assert.equal(options('run', 'app', '--no-browser-sandbox').browserSandbox, false);
  assert.equal(options('batch', 'apps', '--no-browser-sandbox').browserSandbox, false);
  // Unset: SessionOptions' default (on, unless SANDBURG_NO_BROWSER_SANDBOX=1).
  assert.equal(options('run', 'app').browserSandbox, undefined);
  // --browser-sandbox asks for it even where the environment turns it off.
  assert.equal(options('run', 'app', '--browser-sandbox').browserSandbox, true);
  assert.throws(() => parseCommandLine(['run', 'app', '--browser-sandbox=no']));
});

test('open shows its browser; run and batch do unless --headed', () => {
  assert.equal(options('open', 'app').headless, false);
  assert.equal(options('run', 'app').headless, true);
  assert.equal(options('run', 'app', '--headed').headless, false);
});

/** main(argv)'s exit code and what it printed to stderr. */
async function cli(...argv: string[]): Promise<{ code: number; stderr: string }> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    return { code: await main(argv), stderr: lines.join('\n') };
  } finally {
    console.error = error;
  }
}

test('an unknown command or option value is a usage error (64), found before the browser starts', async () => {
  assert.deepEqual({ ...(await cli('frobnicate')), stderr: undefined }, { code: 64, stderr: undefined });
  assert.match((await cli('frobnicate', 'app')).stderr, /^unknown command: frobnicate\n/);
  assert.match((await cli('run', 'app', '--runtime', 'foo')).stderr, /^--runtime must be node$/);
  assert.equal((await cli('run', 'app', '--runtime', 'foo')).code, 64);
  assert.equal((await cli('compare', 'corpus', '--corpus', 'x')).code, 64);
  assert.equal((await cli('compare', 'corpus', '--reference', 'podman')).code, 64);
});

test("a project, checks file or directory that is not there is an error (2) on one line, and makes no run's directory", async () => {
  const dir = tempDir('sandburg-cli-');
  const out = join(dir, 'runs');
  const missing = join(dir, 'missing');
  for (const argv of [
    ['run', missing, '--out', out],
    ['open', `snapshot:${'0'.repeat(12)}`, '--store', join(dir, 'store'), '--out', out],
    ['run', fixture, '--checks', join(dir, 'nope.spec.ts'), '--out', out],
    ['run', fixture, '--checks', join(dir, 'nope.spec.ts'), '--checks-in', 'page', '--out', out],
    ['batch', missing, '--out', out],
    ['compare', missing],
    ['snapshot', missing, '--store', join(dir, 'store')],
  ]) {
    const { code, stderr } = await cli(...argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(stderr, /^error: [^\n]+$/, argv.join(' '));
  }
  assert.equal(existsSync(out), false);
  // A snapshot id that is not stored says so.
  assert.equal((await cli('snapshot', `snapshot:${'0'.repeat(64)}`, '--store', join(dir, 'store'))).stderr, `error: snapshot ${'0'.repeat(64)}: not found`);
  // A batch's --checks is not loaded up front (its projects may all have their own): what fails is the directory.
  assert.match((await cli('batch', missing, '--checks', join(dir, 'nope.spec.ts'), '--out', out)).stderr, /^error: ENOENT[^\n]*missing'$/);
});

test('compare exits 2 when nothing could be compared, else 0 whatever the apps did', () => {
  const pair = (browser: string, reference: string) => ({ browser: { status: browser }, reference: { status: reference } }) as unknown as ComparePair;
  const report = (n: number, pairs: ComparePair[]) => ({ overall: { n } as Rates, pairs });
  assert.equal(compareExitCode(report(2, [pair('failed', 'passed'), pair('error', 'failed')])), 0);
  assert.equal(compareExitCode(report(0, [pair('passed', 'error')])), 2, 'the reference judged no app');
  assert.equal(compareExitCode(report(2, [pair('error', 'passed'), pair('error', 'failed')])), 2, 'no browser run reached its checks');
  assert.equal(compareExitCode(report(2, [pair('passed', 'error'), pair('failed', 'error')])), 2, 'no reference run reached its checks');
});

/**
 * `sandburg compare` in a process of its own, its Docker reference on a docker CLI that never answers
 * an image inspect: the reference's run hangs as it mounts. Says "hanging" (stderr) once it does.
 */
const HANGING_COMPARE = `
  import { compareCommand } from ${JSON.stringify(new URL('../../src/compare/cli.ts', import.meta.url).href)};
  import { dockerReference } from ${JSON.stringify(new URL('../../src/reference/docker.ts', import.meta.url).href)};
  const { app, report, store, work } = JSON.parse(process.env.COMPARE_TEST);
  const docker = (args) => {
    console.error('docker ' + args.slice(0, 3).join(' '));
    if (args[0] !== 'image') return Promise.resolve('');
    console.error('hanging');
    return new Promise(() => {});
  };
  const reference = dockerReference({ docker, workDir: work });
  const disposeAll = reference.disposeAll;
  reference.disposeAll = async () => {
    console.error('disposeAll');
    await disposeAll();
    console.error('disposed');
  };
  await compareCommand([{ project: app, label: 'app' }], { report, parallel: 1, prewarm: false }, { storeDir: store }, {}, reference);
  console.error('compare returned');
`;

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`compare cut short by ${signal} removes the reference's runs, writes no report and exits ${code}`, { timeout: 120_000 }, async (t) => {
    const dir = tempDir('sandburg-compare-signal-');
    const app = join(dir, 'app');
    await mkdir(app);
    await writeFile(join(app, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    // A Vite app as far as the reference's probe goes (by its config file), with nothing to install.
    await writeFile(join(app, 'vite.config.js'), 'export default {};');
    await writeFile(join(app, 'server.js'), `require('http').createServer((req, res) => res.end('<p>hi</p>')).listen(process.env.PORT || 3000);`);
    const report = join(dir, 'reports', 'fidelity');
    const work = join(dir, 'work');
    const child = spawn(process.execPath, ['--input-type=module', '-e', HANGING_COMPARE], {
      cwd: dir,
      env: { ...process.env, COMPARE_TEST: JSON.stringify({ app, report, store: join(dir, 'store'), work }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Not left running (with its browser) by a test that fails waiting for it.
    t.after(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      const was = stderr;
      stderr += d.toString();
      if (!was.includes('hanging\n') && stderr.includes('hanging\n')) child.kill(signal);
    });
    const [exit] = (await once(child, 'exit')) as [number | null];
    assert.equal(exit, code, stderr);
    assert.match(stderr, new RegExp(`${signal}: removing the reference's containers\\ndisposeAll\\n`));
    // Its run was disposed: its containers looked up by its label (and none found to remove).
    assert.match(stderr.slice(stderr.indexOf('disposeAll')), /docker ps -aq --filter\ndisposed\n/);
    assert.ok(!stderr.includes('compare returned'), stderr);
    assert.equal(existsSync(join(dir, 'reports')), false);
    assert.deepEqual(existsSync(work) ? readdirSync(work) : [], []);
  });
}
