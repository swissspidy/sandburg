/**
 * A/B benchmark of batches: runs a directory of projects (`sandburg batch`) with two revisions,
 * interleaved, and prints the wall time, the per-app medians, the machine's CPU use and the peak
 * memory (proportional set size) of the host's processes and of Chromium's, with the change from
 * base to head.
 *
 *   node scripts/bench-batch.ts [--base origin/main] [--head HEAD] [--corpus dir | --count 12 --seed 1]
 *                               [--parallel 3] [--mode warm] [--rounds 3] [--json out.jsonl]
 *
 * - A revision is a git ref, checked out in a worktree under the temporary directory, as in
 *   scripts/bench.ts (its node_modules is this checkout's when the lockfiles match). Each side runs
 *   its own copy of the corpus.
 * - --corpus: a directory of projects (each with its checks.spec.ts); without it, scripts/corpus
 *   generates --count apps with --seed.
 * - warm: each side first runs the batch once, not measured; its .sandburg/ then carries over
 *   between rounds. cold: each measured batch starts without .sandburg/ (npm's cache stays warm).
 * - --parallel takes a list (2,3,4): each round runs each value.
 * - Memory is sampled every 500 ms from /proc (Linux only): the sum of the PSS of the batch's
 *   process and its descendants, split into the host (Node, npm, esbuild) and Chromium (renderers,
 *   and the rest), and the largest single renderer.
 *
 * Set SANDBURG_CHROMIUM to use a Chromium other than Playwright's.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string', default: 'HEAD' },
    corpus: { type: 'string' },
    count: { type: 'string', default: '12' },
    seed: { type: 'string', default: '1' },
    parallel: { type: 'string', default: '3' },
    mode: { type: 'string', default: 'warm' },
    rounds: { type: 'string', default: '3' },
    json: { type: 'string' },
    timeout: { type: 'string', default: '1800' },
  },
});

const root = resolve(import.meta.dirname, '..');
const rounds = Number(args.rounds);
const parallels = args.parallel.split(',').map(Number);
const mode = args.mode as 'warm' | 'cold';

const RUNNER = `
import { join } from 'node:path';
const [wt, corpus, parallel] = process.argv.slice(2);
process.chdir(wt);
const { Session } = await import(join(wt, 'src/index.ts'));
const { discoverProjects, runBatch } = await import(join(wt, 'src/orchestrator/batch.ts'));
const session = new Session();
const t0 = performance.now();
await session.open();
const items = await discoverProjects(corpus);
const { summary, results } = await runBatch(session, items, { parallel: Number(parallel) });
const wall = performance.now() - t0;
const t1 = performance.now();
await session.close();
const close = performance.now() - t1;
const runs = results.map((r, i) => ({ label: items[i].label, status: r.status, total: Math.round(r.timings.totalMs), phases: Object.fromEntries(r.phases.map((p) => [p.name, Math.round(p.durationMs)])) }));
console.log('BENCH ' + JSON.stringify({ wall: Math.round(wall), batchWall: summary.wallMs, close: Math.round(close), runs }));
`;
const runner = join(tmpdir(), `sandburg-bench-batch-${process.pid}.ts`);
writeFileSync(runner, RUNNER);

function git(...a: string[]): string {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
}

function checkout(ref: string): { dir: string; label: string; corpus: string } {
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
  const dir = join(tmpdir(), 'sandburg-bench', sha.slice(0, 12));
  if (!existsSync(join(dir, 'package.json'))) {
    mkdirSync(join(tmpdir(), 'sandburg-bench'), { recursive: true });
    git('worktree', 'add', '--detach', '--force', dir, sha);
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    const same = readFileSync(join(dir, 'package-lock.json'), 'utf8') === readFileSync(join(root, 'package-lock.json'), 'utf8');
    if (same) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    else execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  }
  const corpus = join(tmpdir(), 'sandburg-bench-corpus', sha.slice(0, 12));
  rmSync(corpus, { recursive: true, force: true });
  mkdirSync(corpus, { recursive: true });
  if (args.corpus) cpSync(resolve(args.corpus), corpus, { recursive: true });
  else execFileSync(process.execPath, [join(root, 'scripts/corpus/generate.ts'), corpus, args.count, args.seed], { stdio: 'ignore' });
  return { dir, label: `${ref} (${sha.slice(0, 7)})`, corpus };
}

// --- /proc sampling -------------------------------------------------------------------------------

function children(pid: number): number[] {
  const out: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const c = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
      if (c) out.push(...c.split(/\s+/).map(Number));
    }
  } catch {}
  return out;
}

function tree(pid: number): number[] {
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...children(all[i]));
  return all;
}

function pss(pid: number): number {
  try {
    const m = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function kind(pid: number): 'renderer' | 'chromium' | 'host' {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!/chrom/i.test(cmd.split('\0')[0])) return 'host';
    return cmd.includes('--type=renderer') ? 'renderer' : 'chromium';
  } catch {
    return 'host';
  }
}

function cpuTicks(): { busy: number; total: number } {
  const f = readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = f[3] + f[4];
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

interface Peak {
  host: number;
  renderers: number;
  chromium: number;
  all: number;
  renderer: number;
}

interface Batch {
  wall: number;
  batchWall: number;
  close: number;
  runs: { label: string; status: string; total: number; phases: Record<string, number> }[];
}

function measure(side: { dir: string; corpus: string }, parallel: number): Promise<{ batch: Batch; peak: Peak; cpu: number } | null> {
  if (mode === 'cold') rmSync(join(side.dir, '.sandburg'), { recursive: true, force: true });
  return new Promise((done) => {
    const child = spawn(process.execPath, [runner, side.dir, side.corpus, String(parallel)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    const peak: Peak = { host: 0, renderers: 0, chromium: 0, all: 0, renderer: 0 };
    const cpu0 = cpuTicks();
    const timer = setInterval(() => {
      const now = { host: 0, renderers: 0, chromium: 0, renderer: 0 };
      for (const pid of tree(child.pid!)) {
        const k = kind(pid);
        const m = pss(pid);
        if (k === 'renderer') {
          now.renderers += m;
          now.renderer = Math.max(now.renderer, m);
        } else if (k === 'chromium') now.chromium += m;
        else now.host += m;
      }
      peak.host = Math.max(peak.host, now.host);
      peak.renderers = Math.max(peak.renderers, now.renderers);
      peak.chromium = Math.max(peak.chromium, now.chromium + now.renderers);
      peak.all = Math.max(peak.all, now.host + now.chromium + now.renderers);
      peak.renderer = Math.max(peak.renderer, now.renderer);
    }, 500);
    const kill = setTimeout(() => child.kill('SIGKILL'), Number(args.timeout) * 1000);
    child.on('exit', (code, signal) => {
      clearInterval(timer);
      clearTimeout(kill);
      const cpu1 = cpuTicks();
      const line = stdout.split('\n').find((l) => l.startsWith('BENCH '));
      if (!line) {
        console.error(`  no result (exit ${code}${signal ? `, ${signal}` : ''})\n${stderr.split('\n').slice(-15).join('\n')}`);
        return done(null);
      }
      done({ batch: JSON.parse(line.slice(6)), peak, cpu: (cpu1.busy - cpu0.busy) / (cpu1.total - cpu0.total) });
    });
  });
}

const variants = { base: checkout(args.base), head: checkout(args.head) };
if (variants.base.dir === variants.head.dir) throw new Error('base and head are the same revision');
console.error(`base: ${variants.base.label}\nhead: ${variants.head.label}\nmode: ${mode}, parallel ${parallels.join(',')}`);

if (mode === 'warm') {
  for (const v of ['base', 'head'] as const) {
    console.error(`  warming ${v}…`);
    await measure(variants[v], parallels[0]);
  }
}

interface Sample {
  variant: 'base' | 'head';
  parallel: number;
  round: number;
  wall: number;
  close: number;
  cpu: number;
  peak: Peak;
  runs: Batch['runs'];
}
const samples: Sample[] = [];
const mb = (b: number) => `${Math.round(b / 2 ** 20)} MB`;
for (let round = 1; round <= rounds; round++) {
  const order: ('base' | 'head')[] = round % 2 ? ['base', 'head'] : ['head', 'base'];
  for (const parallel of parallels) {
    for (const variant of order) {
      const m = await measure(variants[variant], parallel);
      if (!m) continue;
      const s: Sample = { variant, parallel, round, wall: m.batch.batchWall, close: m.batch.close, cpu: m.cpu, peak: m.peak, runs: m.batch.runs };
      samples.push(s);
      const passed = s.runs.filter((r) => r.status === 'passed').length;
      console.error(
        `  round ${round} ${variant} p${parallel}: ${(s.wall / 1000).toFixed(1)} s, ${passed}/${s.runs.length} passed, cpu ${Math.round(s.cpu * 100)}%, ` +
          `peak host ${mb(s.peak.host)} renderers ${mb(s.peak.renderers)} chromium ${mb(s.peak.chromium)} all ${mb(s.peak.all)} (largest renderer ${mb(s.peak.renderer)})`,
      );
      if (args.json) appendFileSync(args.json, JSON.stringify(s) + '\n');
    }
  }
}
rmSync(runner, { force: true });

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) || !a ? '–' : `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`);
const lines = [`Batch benchmark (${mode}): base ${variants.base.label} vs head ${variants.head.label}, ${rounds} rounds, medians.`, '', '| Parallel | Metric | Base | Head | Change |', '|---|---|---|---|---|'];
for (const parallel of parallels) {
  const of = (v: 'base' | 'head') => samples.filter((s) => s.variant === v && s.parallel === parallel);
  const row = (name: string, pick: (s: Sample) => number, fmt: (x: number) => string) => {
    const [b, h] = [median(of('base').map(pick)), median(of('head').map(pick))];
    lines.push(`| ${parallel} | ${name} | ${Number.isNaN(b) ? '–' : fmt(b)} | ${Number.isNaN(h) ? '–' : fmt(h)} | ${pct(b, h)} |`);
  };
  const s = (x: number) => `${(x / 1000).toFixed(2)} s`;
  row('**wall**', (x) => x.wall, s);
  row('per-app median', (x) => median(x.runs.map((r) => r.total)), s);
  row('passed', (x) => x.runs.filter((r) => r.status === 'passed').length, String);
  row('close', (x) => x.close, s);
  row('CPU (machine)', (x) => x.cpu, (x) => `${Math.round(x * 100)}%`);
  row('peak host', (x) => x.peak.host, mb);
  row('peak renderers', (x) => x.peak.renderers, mb);
  row('peak Chromium', (x) => x.peak.chromium, mb);
  row('peak all', (x) => x.peak.all, mb);
  row('largest renderer', (x) => x.peak.renderer, mb);
}
console.log(lines.join('\n'));
