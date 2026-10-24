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
const { monitorEventLoopDelay, performance: perf } = await import('node:perf_hooks');
const session = new Session();
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const elu0 = perf.eventLoopUtilization();
const t0 = performance.now();
const epoch = Date.now();
await session.open();
const items = await discoverProjects(corpus);
const { summary, results } = await runBatch(session, items, { parallel: Number(parallel) });
const wall = performance.now() - t0;
const elu = perf.eventLoopUtilization(elu0).utilization;
delay.disable();
const t1 = performance.now();
await session.close();
const close = performance.now() - t1;
const runs = results.map((r, i) => ({ label: items[i].label, status: r.status, total: Math.round(r.timings.totalMs), at: Date.parse(r.startedAt) - epoch, phases: Object.fromEntries(r.phases.map((p) => [p.name, Math.round(p.durationMs)])) }));
const loop = { utilization: Math.round(elu * 100) / 100, p99: Math.round(delay.percentile(99) / 1e6), max: Math.round(delay.max / 1e6) };
console.log('BENCH ' + JSON.stringify({ wall: Math.round(wall), batchWall: summary.wallMs, close: Math.round(close), loop, runs }));
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

const kinds = new Map<number, { kind: 'renderer' | 'chromium' | 'host'; name: string }>();
function kind(pid: number): { kind: 'renderer' | 'chromium' | 'host'; name: string } {
  let k = kinds.get(pid);
  if (k) return k;
  try {
    // Chromium's processes rewrite their command line as one string, the arguments joined by spaces.
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/).filter(Boolean);
    const type = cmd.find((a) => a.startsWith('--type='))?.slice(7);
    const utility = cmd.find((a) => a.startsWith('--utility-sub-type='))?.slice(19);
    if (/chrom/i.test(cmd[0])) k = { kind: type === 'renderer' ? 'renderer' : 'chromium', name: type ? (utility ?? type) : 'browser' };
    else {
      const script = cmd.slice(1).find((a) => /npm|esbuild/.test(a));
      k = { kind: 'host', name: [cmd[0], script].filter(Boolean).map((a) => a!.split('/').pop()).join(' ') };
    }
  } catch {
    k = { kind: 'host', name: '?' };
  }
  // A renderer starts as a fork of Chromium's zygote, with its command line.
  if (k.name !== 'zygote') kinds.set(pid, k);
  return k;
}

/** CPU seconds a process has used (user + system). */
function cpuOf(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return (Number(rest[11]) + Number(rest[12])) / 100;
  } catch {
    return -1;
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
  /** The host's main thread: event loop utilization, and its delay's 99th percentile and maximum (ms). */
  loop: { utilization: number; p99: number; max: number };
  /** at: when the run started, in ms from the session's start. */
  runs: { label: string; status: string; total: number; at: number; phases: Record<string, number> }[];
}

function measure(side: { dir: string; corpus: string }, parallel: number): Promise<{ batch: Batch; peak: Peak; cpu: number; cpuBy: Record<string, number>; timeline: number[] } | null> {
  if (mode === 'cold') rmSync(join(side.dir, '.sandburg'), { recursive: true, force: true });
  return new Promise((done) => {
    const child = spawn(process.execPath, [runner, side.dir, side.corpus, String(parallel)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    const peak: Peak = { host: 0, renderers: 0, chromium: 0, all: 0, renderer: 0 };
    const cpu0 = cpuTicks();
    // The last CPU time seen of each process (an ended one keeps it), by kind.
    const used = new Map<number, { name: string; s: number }>();
    // The machine's CPU use in each sample period.
    const timeline: number[] = [];
    let last = cpu0;
    const timer = setInterval(() => {
      const now = { host: 0, renderers: 0, chromium: 0, renderer: 0 };
      const ticks = cpuTicks();
      timeline.push(Math.round(((ticks.busy - last.busy) / (ticks.total - last.total || 1)) * 100));
      last = ticks;
      for (const pid of tree(child.pid)) {
        const { kind: k, name } = kind(pid);
        const c = cpuOf(pid);
        if (c >= 0) used.set(pid, { name: pid === child.pid ? 'host' : name, s: c });
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
      const cpuBy: Record<string, number> = {};
      for (const { name, s } of used.values()) cpuBy[name] = Math.round(((cpuBy[name] ?? 0) + s) * 10) / 10;
      done({ batch: JSON.parse(line.slice(6)), peak, cpu: (cpu1.busy - cpu0.busy) / (cpu1.total - cpu0.total), cpuBy, timeline });
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
  loop: Batch['loop'];
  /** CPU seconds by process (host, browser, renderer, gpu-process, network, node npm-cli.js, …), as last sampled. */
  cpuBy: Record<string, number>;
  /** The machine's CPU use (%) every 500 ms, from the process's start. */
  timeline: number[];
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
      const s: Sample = { variant, parallel, round, wall: m.batch.batchWall, close: m.batch.close, cpu: m.cpu, loop: m.batch.loop, cpuBy: m.cpuBy, timeline: m.timeline, peak: m.peak, runs: m.batch.runs };
      samples.push(s);
      const passed = s.runs.filter((r) => r.status === 'passed').length;
      console.error(
        `  round ${round} ${variant} p${parallel}: ${(s.wall / 1000).toFixed(1)} s, ${passed}/${s.runs.length} passed, cpu ${Math.round(s.cpu * 100)}%, ` +
          `peak host ${mb(s.peak.host)} renderers ${mb(s.peak.renderers)} chromium ${mb(s.peak.chromium)} all ${mb(s.peak.all)} (largest renderer ${mb(s.peak.renderer)})\n    host loop ${JSON.stringify(s.loop)}, cpu s: ${JSON.stringify(s.cpuBy)}`,
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
  row('host event loop busy', (x) => x.loop.utilization, (x) => `${Math.round(x * 100)}%`);
  row('host event loop delay p99', (x) => x.loop.p99, (x) => `${x} ms`);
  for (const name of ['host', 'renderer', 'browser', 'gpu-process']) row(`CPU s: ${name}`, (x) => x.cpuBy[name] ?? 0, (x) => x.toFixed(1));
  row('peak host', (x) => x.peak.host, mb);
  row('peak renderers', (x) => x.peak.renderers, mb);
  row('peak Chromium', (x) => x.peak.chromium, mb);
  row('peak all', (x) => x.peak.all, mb);
  row('largest renderer', (x) => x.peak.renderer, mb);
}
console.log(lines.join('\n'));
