/** scripts/fidelity-study.ts: what it refuses before it runs anything, and its report from kept passes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from './temp-dir.ts';

const script = fileURLToPath(new URL('../../scripts/fidelity-study.ts', import.meta.url));
// Not as a subtest of this file's run (node:test tells its children so in NODE_TEST_CONTEXT).
const { NODE_TEST_CONTEXT: _, SANDBURG_INSTALL_DIR: _dir, NODE_COMPILE_CACHE: _cache, ...env } = process.env;

/** A corpus of two apps (meta.json only: nothing here runs them). */
function corpus(): string {
  const dir = tempDir('sandburg-study-corpus-');
  for (const [app, expected] of [
    ['000-static', 'pass'],
    ['001-static', 'fail'],
  ]) {
    mkdirSync(join(dir, app));
    writeFileSync(join(dir, app, 'meta.json'), JSON.stringify({ framework: 'static', fault: expected === 'pass' ? 'none' : 'crash', expected }));
  }
  return dir;
}

const run = (app: string, result: 'pass' | 'fail', totalMs: number) => ({
  app,
  result,
  failureClass: result === 'pass' ? null : 'app-bug',
  rule: result === 'pass' ? null : 'blocking-check-failed',
  totalMs,
  phases: { install: 100, start: 200, ready: 300, checks: totalMs - 600 },
  startMs: 0,
  endMs: totalMs,
  neighbours: 1,
  cpu: 50,
});

/** A kept pass, as the script appends it to <out>-passes.jsonl. */
const kept = (dir: string, mode: 'cold' | 'warm', params: Record<string, unknown>, times: [number, number]) =>
  JSON.stringify({ round: 1, mode, params: { corpus: dir, apps: ['000-static', '001-static'], parallel: 3, only: null, commit: 'abc', ...params }, pass: { wallMs: 9000, runs: [run('000-static', 'pass', times[0]), run('001-static', 'fail', times[1])] } }) + '\n';

async function study(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return promisify(execFile)(process.execPath, [script, ...args], { cwd, env: { ...env, ...extra } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
}

test('fidelity-study refuses to go on from passes kept with other arguments, and names the difference', async () => {
  const dir = corpus();
  const out = join(tempDir('sandburg-study-out-'), 'study');
  writeFileSync(`${out}-passes.jsonl`, kept(dir, 'cold', { parallel: 2 }, [1000, 5000]));
  const r = await study(dir, [dir, '--parallel', '1', '--out', out]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /holds a cold pass \(round 1\) run with --parallel 2, not 1/);

  writeFileSync(`${out}-passes.jsonl`, kept(dir, 'cold', { apps: ['000-static'] }, [1000, 5000]));
  assert.match((await study(dir, [dir, '--out', out])).stderr, /run with the apps \(1 of them, not these 2\)/);

  // A pass kept by an earlier version of the script, without what it ran with.
  writeFileSync(`${out}-passes.jsonl`, JSON.stringify({ round: 1, mode: 'cold', pass: { wallMs: 1, runs: [] } }) + '\n');
  assert.match((await study(dir, [dir, '--out', out])).stderr, /without its parameters/);
});

test('fidelity-study refuses an --out under .sandburg/ and stores a cold pass would not remove', async () => {
  const dir = corpus();
  const r = await study(dir, [dir, '--out', '.sandburg/study/vN']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /under \.sandburg\//);
  for (const name of ['SANDBURG_INSTALL_DIR', 'NODE_COMPILE_CACHE']) {
    const e = await study(dir, [dir], { [name]: join(dir, 'elsewhere') });
    assert.equal(e.code, 64);
    assert.match(e.stderr, new RegExp(`${name} is set`));
  }
});

test('fidelity-study --report renders the kept passes: medians of the apps that pass in both, joined by label', async () => {
  const dir = corpus();
  const out = join(tempDir('sandburg-study-out-'), 'study');
  // Kept at another commit: a report is of the passes kept, whatever this checkout's commit.
  writeFileSync(`${out}-passes.jsonl`, kept(dir, 'cold', {}, [2000, 6000]) + kept(dir, 'warm', {}, [1000, 4000]));
  const r = await study(dir, [dir, '--report', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\| static \| 2 \| 2 \/ 2 \| 0 \/ 0 \| 1\/1 \/ 1\/1 \| 2\.0 s → 1\.0 s \| 0 of 1 \| 50% \/ 50% \|/);
  const cold = JSON.parse(readFileSync(`${out}.json`, 'utf8')) as { commit: string; apps: { app: string; totalMs: number | null; passedRounds: number }[] };
  assert.equal(cold.commit, 'abc');
  assert.deepEqual(
    cold.apps.map((a) => [a.app, a.totalMs, a.passedRounds]),
    [
      ['000-static', 2000, 1],
      ['001-static', null, 0],
    ],
  );

  // A report needs every pass it reports.
  writeFileSync(`${out}-passes.jsonl`, kept(dir, 'cold', {}, [2000, 6000]));
  assert.match((await study(dir, [dir, '--report', '--out', out])).stderr, /has no warm pass for round 1/);
});
