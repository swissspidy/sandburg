/** The command line's options as the session gets them (src/cli.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
});

test('compare exits 2 when nothing could be compared, else 0 whatever the apps did', () => {
  const pair = (browser: string, reference: string) => ({ browser: { status: browser }, reference: { status: reference } }) as unknown as ComparePair;
  const report = (n: number, pairs: ComparePair[]) => ({ overall: { n } as Rates, pairs });
  assert.equal(compareExitCode(report(2, [pair('failed', 'passed'), pair('error', 'failed')])), 0);
  assert.equal(compareExitCode(report(0, [pair('passed', 'error')])), 2, 'the reference judged no app');
  assert.equal(compareExitCode(report(2, [pair('error', 'passed'), pair('error', 'failed')])), 2, 'no browser run reached its checks');
  assert.equal(compareExitCode(report(2, [pair('passed', 'error'), pair('failed', 'error')])), 2, 'no reference run reached its checks');
});
