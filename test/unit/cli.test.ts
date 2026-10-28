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
 * `sandburg compare` in a process of its own, without a browser or Docker: its session's browser runs
 * pass at once, and its reference's run mounts and installs (as Session.run does) on a docker CLI that
 * never answers `hang` (an image inspect: before anything exists; an exec, npm's install: once the
 * container and the project copy do), so it hangs. Says "hanging" (stderr) once it does. On Windows,
 * where a process cannot signal another (kill() ends it without running its handlers), the test
 * names the signal on its stdin and it is raised here, to the listeners compare installed.
 */
const HANGING_COMPARE = `
  import { compareCommand } from ${JSON.stringify(new URL('../../src/compare/cli.ts', import.meta.url).href)};
  import { dockerReference } from ${JSON.stringify(new URL('../../src/reference/docker.ts', import.meta.url).href)};
  import { loadProject } from ${JSON.stringify(new URL('../../src/project.ts', import.meta.url).href)};
  const { app, report, work, hang } = JSON.parse(process.env.COMPARE_TEST);
  if (process.platform === 'win32') process.stdin.on('data', (d) => { const signal = String(d).trim(); process.emit(signal, signal); });
  /** The run's container (docker run -d), found by its label (ps -aq) until it is removed (rm -f). */
  let container = false;
  const docker = (args) => {
    console.error('docker ' + args.slice(0, 3).join(' '));
    if (args[0] !== hang) {
      if (args[0] === 'run' && args[1] === '-d') container = true;
      if (args[0] === 'rm') container = false;
      return Promise.resolve(container && ((args[0] === 'run' && args[1] === '-d') || (args[0] === 'ps' && args[1] === '-aq')) ? 'cid\\n' : '');
    }
    console.error('hanging');
    // As the docker process it stands for, it keeps the process alive while it runs.
    return new Promise(() => setInterval(() => {}, 60_000));
  };
  const reference = dockerReference({ docker, workDir: work });
  const disposeAll = reference.disposeAll;
  reference.disposeAll = async () => {
    console.error('disposeAll');
    await disposeAll();
    console.error('disposed');
  };
  const session = {
    browserSandbox: true,
    async open() {},
    // As a browser's, it takes a while: what the batch does meanwhile (a report it would write) shows.
    async close() {
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.error('session closed');
    },
    async run(path, options) {
      const project = await loadProject(path);
      // A mount or install the signal's disposeAll cut short ends its run as an error result, as Session.run's does.
      const runtime = options.nodeRuntime?.();
      const failure = runtime ? await runtime.mount(project, () => {}).then(() => runtime.install()).then(() => null, (e) => ({ class: 'infra', rule: 'infra-error', message: String(e) })) : null;
      return {
        runId: 'r', status: failure ? 'error' : 'passed', failure, checks: [],
        project: { name: project.name, path, framework: project.framework, snapshotId: 's' },
        runtime: { name: 'node', version: '1' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 1 },
      };
    },
  };
  await compareCommand([{ project: app, label: 'app' }], { report, parallel: 1, prewarm: false }, {}, {}, { reference, session: () => session });
  console.error('compare returned');
`;

const windows = process.platform === 'win32';
for (const [signal, code, hang] of [['SIGINT', 130, 'image'], ['SIGTERM', 143, 'image'], ['SIGINT', 130, 'exec']] as const) {
  test(`compare cut short by ${signal} (at docker ${hang}) removes the reference's runs, writes no report and exits ${code}`, { timeout: 120_000 }, async (t) => {
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
      env: { ...process.env, COMPARE_TEST: JSON.stringify({ app, report, work, hang }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Not left running (with its browser) by a test that fails waiting for it.
    t.after(() => child.kill('SIGKILL'));
    let stderr = '';
    /** The project copies there were as the signal was sent. */
    let copies: string[] | null = null;
    child.stderr.on('data', (d: Buffer) => {
      const was = stderr;
      stderr += d.toString();
      if (!was.includes('hanging\n') && stderr.includes('hanging\n')) {
        copies = existsSync(work) ? readdirSync(work) : [];
        // Windows: the child raises it (see HANGING_COMPARE).
        if (windows) child.stdin.write(`${signal}\n`);
        else child.kill(signal);
      }
    });
    const [exit] = (await once(child, 'exit')) as [number | null];
    assert.equal(exit, code, stderr);
    assert.match(stderr, new RegExp(`${signal}: removing the reference's containers\\ndisposeAll\\n`));
    // Its run was disposed (its container looked up by its label and removed, once there is one), then the session closed.
    const removed = hang === 'exec' ? 'docker rm -f cid\n' : '';
    assert.match(stderr.slice(stderr.indexOf('disposeAll')), new RegExp(`docker ps -aq --filter\\n${removed}disposed\\nsession closed\\n`));
    // Its project copy, there once it mounted, is removed too.
    assert.equal(copies!.length, hang === 'exec' ? 1 : 0);
    assert.ok(!stderr.includes('compare returned'), stderr);
    assert.equal(existsSync(join(dir, 'reports')), false);
    assert.deepEqual(existsSync(work) ? readdirSync(work) : [], []);
  });
}
