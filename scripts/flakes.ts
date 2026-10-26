/**
 * Runs test files again and again, optionally under load, and counts which tests fail: the way to
 * find a flaky test before CI does (docs/testing.md).
 *
 *   node scripts/flakes.ts [--runs 10] [--cpu 4] [--disk] [--copies 1] <test files…>
 *
 * --runs    how many times each file runs (default 10), one after another;
 * --cpu     that many processes spinning on the CPU meanwhile (default 0);
 * --disk    a process writing and syncing 64 MB files meanwhile, in the system's temp directory;
 * --copies  that many runs of the files at once (default 1): runs of a suite side by side on one
 *           .sandburg/, as two suites, or two sessions, on one machine do.
 *
 * Prints each run's failures as it ends, then each failing test with how often it failed. Exits 1 if
 * any test failed. Each run's output is in the system's temp directory (the path is printed).
 * Example: `node scripts/flakes.ts --runs 10 --cpu 4 --disk test/runtime/*.test.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from 'node:test';

const { values, positionals: files } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string', default: '10' }, cpu: { type: 'string', default: '0' }, disk: { type: 'boolean', default: false }, copies: { type: 'string', default: '1' } },
});
if (!files.length) {
  console.error('usage: node scripts/flakes.ts [--runs 10] [--cpu 4] [--disk] [--copies 1] <test files…>');
  process.exit(2);
}
const count = (name: 'runs' | 'cpu' | 'copies', min: number) => {
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name}: a whole number of at least ${min}, not ${JSON.stringify(values[name])}`);
    process.exit(2);
  }
  return n;
};
const runs = count('runs', 1);
const copies = count('copies', 1);
const cpu = count('cpu', 0);
const out = mkdtempSync(join(tmpdir(), 'sandburg-flakes-'));

// Each load process ends when this one is gone, however it ended (a kill, a cancelled job): it
// looks at its parent's pid as it goes.
const orphaned = 'const parent = process.ppid; const gone = () => process.ppid !== parent;';
const load: ChildProcess[] = [];
for (let i = 0; i < cpu; i++) load.push(spawn(process.execPath, ['-e', `${orphaned} for (let i = 0; ; i++) if ((i & 0xffffff) === 0 && gone()) process.exit();`], { stdio: 'ignore' }));
const file = join(out, 'disk-load.bin');
if (values.disk) {
  const writer = `${orphaned} const fs = require('fs'); const b = Buffer.alloc(1 << 20); while (!gone()) { const fd = fs.openSync(${JSON.stringify(file)}, 'w'); for (let i = 0; i < 64; i++) fs.writeSync(fd, b); fs.fsyncSync(fd); fs.closeSync(fd); fs.rmSync(${JSON.stringify(file)}); }`;
  load.push(spawn(process.execPath, ['-e', writer], { stdio: 'ignore' }));
}
const stopLoad = () => {
  load.forEach((p) => p.kill());
  rmSync(file, { force: true });
};
process.on('exit', stopLoad);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) process.on(signal, () => process.exit(code));

/**
 * One run of the files: the tests that failed ("file › parent › name"), and its spec output. A
 * failing test is counted by its own name, and once: a parent that fails because a subtest did is
 * not counted again (node:test reports a subtest before its parent, and a file's tests one after
 * another).
 */
async function once(): Promise<{ failed: string[]; log: string }> {
  const failed: string[] = [];
  let log = '';
  /** By file: the names of the tests running at each nesting, and whether a subtest at each nesting failed. */
  const byFile = new Map<string, { names: string[]; childFailed: boolean[] }>();
  const of = (file = '?') => byFile.get(file) ?? (byFile.set(file, { names: [], childFailed: [] }), byFile.get(file)!);
  // As npm test runs them: one process per file (e2e files one at a time, as their scripts do).
  const stream = run({ files, concurrency: files.some((f) => f.includes('/e2e/')) ? 1 : true });
  for await (const event of stream as AsyncIterable<{ type: string; data: { name: string; nesting: number; file?: string; details?: { error?: unknown; duration_ms?: number } } }>) {
    const { type, data } = event;
    let leaf = false;
    if (type === 'test:start') of(data.file).names[data.nesting] = data.name;
    else if (type === 'test:pass' || type === 'test:fail') {
      const f = of(data.file);
      const fromSubtest = f.childFailed[data.nesting + 1] === true;
      f.childFailed[data.nesting + 1] = false;
      if (type === 'test:fail') {
        f.childFailed[data.nesting] = true;
        leaf = !fromSubtest;
        if (leaf) failed.push([data.file ?? '?', ...f.names.slice(0, data.nesting), data.name].join(' › '));
      }
    }
    if (leaf) {
      const error = ((data.details?.error as Error | undefined)?.cause ?? data.details?.error) as Error | undefined;
      log += `✖ ${'  '.repeat(data.nesting)}${data.name} (${data.details?.duration_ms?.toFixed(0)} ms)\n  ${(error?.stack ?? String(error)).split('\n').join('\n  ')}\n`;
    } else if (type === 'test:fail' && data.nesting === 0) log += `✖ ${data.name} (its subtests failed)\n`;
    else if (type === 'test:pass' && data.nesting === 0) log += `✔ ${data.name} (${data.details?.duration_ms?.toFixed(0)} ms)\n`;
    else if (type === 'test:stderr' || type === 'test:stdout') log += (data as unknown as { message: string }).message;
  }
  return { failed, log };
}

const counts = new Map<string, number>();
let failedRuns = 0;
for (let i = 1; i <= runs; i++) {
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: copies }, () => once()));
  results.forEach((r, c) => writeFileSync(join(out, `run-${i}${copies > 1 ? `-${c + 1}` : ''}.log`), r.log));
  const failed = results.flatMap((r) => r.failed);
  if (failed.length) failedRuns++;
  for (const f of failed) counts.set(f, (counts.get(f) ?? 0) + 1);
  console.log(`run ${i}/${runs}: ${failed.length ? `${failed.length} failed` : 'passed'} (${((performance.now() - t0) / 1000).toFixed(0)} s)${failed.map((f) => `\n  ✖ ${f}`).join('')}`);
}
stopLoad();
console.log(`\n${failedRuns} of ${runs} runs failed${copies > 1 ? ` (${copies} copies each)` : ''}; logs in ${out}`);
for (const [test, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${test}`);
process.exitCode = failedRuns ? 1 : 0;
