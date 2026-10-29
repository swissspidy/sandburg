/**
 * A fidelity study's cold and warm passes over a corpus (scripts/corpus), with each run's answer
 * compared with the app's ground truth (meta.json's `expected`), and the per-framework table.
 *
 *   node scripts/fidelity-study.ts [corpus] [--parallel 3] [--rounds 1] [--only <regex>] [--out docs/fidelity/vN-node-vs-truth] [--report]
 *
 * - cold: the batch starts from empty Sandburg stores (.sandburg/ removed). What it does not
 *   remove stays warm: npm's own download cache (~/.npm) and the OS's page cache. A store kept
 *   elsewhere would stay warm too, so the study refuses to run with SANDBURG_INSTALL_DIR or
 *   NODE_COMPILE_CACHE set. warm: the same apps again, on the stores the cold pass left.
 * - Both passes start the apps in the same order (the corpus's), with the same parallelism. A batch
 *   otherwise starts the apps that ran longest in its earlier batches first (BatchOptions.longestFirst),
 *   which only the warm pass has: in v7 that started the fast apps last, side by side, and made their
 *   warm runs look slower than cold. The same start order is not the same overlap (a cold pass's
 *   runs are longer); `neighbours` and `cpu` say what each run ran beside. Each pass keeps its batch
 *   summaries in a directory of its own, so neither reads the other's.
 * - --rounds n runs n cold/warm pairs, one after the other (cold, warm, cold, warm, ...), so that drift
 *   in the machine's load falls on both. An app's answer is the first round's; each round's is in
 *   `rounds`.
 * - Times: an app's time in a pass is the median of its passing rounds. The table's medians are over
 *   the apps that pass in both passes (in at least one round of each), so that cold and warm are
 *   medians of the same apps.
 * - With --out, each pass is kept as it ends (<out>-passes.jsonl), with what it was run with (the
 *   corpus, its apps, --parallel, --only, the commit): the same command again goes on from the first
 *   pass it does not have, and one with other arguments, or at another commit, is refused. --out
 *   may not be under .sandburg/, which a cold pass removes.
 * - --report: no runs; the table and the JSON from the passes kept at --out, as they were run (their
 *   corpus, apps and the apps' meta.json, --parallel, --only and commit), over every round kept
 *   unless --rounds says how many.
 * - --only: the apps whose framework (meta.json) matches, e.g. 'vue|static|lit'.
 * - --out writes <out>.json (cold) and <out>-warm.json (warm), each app with its phases, when it
 *   started and ended (ms from its pass's start), `neighbours`: the mean number of other runs open
 *   while it ran, and `cpu`: the machine's mean CPU use while it ran (Linux; else null). Per-app
 *   times at --parallel above 1 are mostly what runs beside the app: compare cold with warm per app
 *   where `cpu` is alike, or at --parallel 1.
 *
 * Set SANDBURG_CHROMIUM to use a Chromium other than Playwright's.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Session } from '../src/index.ts';
import { discoverProjects, runBatch, type BatchItem } from '../src/orchestrator/batch.ts';
import { readPass, writePass } from './study-pass.ts';
import type { RunResult } from '../src/types.ts';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    parallel: { type: 'string' },
    rounds: { type: 'string' },
    only: { type: 'string' },
    out: { type: 'string' },
    report: { type: 'boolean', default: false },
    // Internal: run one pass in this process and print it (each pass is a process of its own).
    pass: { type: 'string' },
  },
});

/** Exits with a usage error (64), as the CLI does. */
function refuse(message: string): never {
  console.error(`fidelity-study: ${message}`);
  process.exit(64);
}

/** A positive whole number of the option's, or a refusal. */
function count(name: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) refuse(`--${name} ${value}: a positive whole number`);
  return n;
}

interface Meta {
  framework: string;
  fault: string;
  expected: 'pass' | 'fail';
}

interface Run {
  app: string;
  result: 'pass' | 'fail';
  failureClass: string | null;
  rule: string | null;
  totalMs: number;
  phases: Record<string, number>;
  startMs: number;
  endMs: number;
  neighbours: number;
  /** The machine's mean CPU use (%) while it ran, from /proc/stat (Linux only; else null). */
  cpu: number | null;
}

interface Pass {
  wallMs: number;
  runs: Run[];
}

/** What a pass was run with: a kept pass is used only by a study run with the same. */
interface Params {
  corpus: string;
  apps: string[];
  /** Each app's meta.json as the pass ran it (a report counts by these, not by today's corpus). */
  meta: Record<string, Meta>;
  parallel: number;
  only: string | null;
  commit: string | null;
}

interface Kept {
  round: number;
  mode: 'cold' | 'warm';
  params: Params;
  pass: Pass;
}

/** The machine's busy and total CPU ticks, or null where /proc/stat is not there. */
async function cpuTicks(): Promise<{ busy: number; total: number } | null> {
  const stat = await readFile('/proc/stat', 'utf8').catch(() => null);
  if (!stat) return null;
  const f = stat.split('\n')[0].split(/\s+/).slice(1).map(Number);
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - f[3] - f[4], total };
}

if (!args.report) {
  for (const name of ['SANDBURG_INSTALL_DIR', 'NODE_COMPILE_CACHE']) {
    if (process.env[name]) refuse(`${name} is set: a cold pass removes .sandburg/ only, and would start from what ${process.env[name]} holds`);
  }
}
if (args.out) {
  const under = relative(resolve('.sandburg'), resolve(args.out));
  if (!under.startsWith('..') && !isAbsolute(under)) refuse(`--out ${args.out} is under .sandburg/, which a cold pass removes`);
}
if (args.report && !args.out) refuse('--report reads the passes kept at --out');
if (args.report && (positionals.length || args.parallel !== undefined || args.only !== undefined)) refuse('--report takes the corpus, --parallel and --only of the passes it reports: name none of them');

// With --out, each pass is kept as it ends (<out>-passes.jsonl), and a study run again with the same
// arguments goes on from the first pass it does not have (a warm pass on the stores its cold pass left).
const kept = args.out ? `${args.out}-passes.jsonl` : null;
const done = kept
  ? (await readFile(kept, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Kept)
  : [];
for (const d of done) if (!d.params?.meta) refuse(`${kept} holds a ${d.mode} pass (round ${d.round}) kept without its parameters: use another --out, or remove it`);
if (args.report && !done.length) refuse(`${kept} holds no passes`);

// A study runs the corpus as it is now; a report is of the passes kept, as they were run (their
// corpus, apps, parallelism, filter and commit, and their apps' meta.json).
const ran = args.report ? done[0].params : null;
const corpus = ran?.corpus ?? resolve(positionals[0] ?? 'corpus');
const parallel = ran?.parallel ?? count('parallel', args.parallel ?? '3');
const only = ran ? ran.only : (args.only ?? null);
const items: (BatchItem & { meta: Meta })[] = [];
if (ran) for (const label of ran.apps) items.push({ project: join(corpus, label), label, meta: ran.meta[label] });
else {
  for (const item of await discoverProjects(corpus)) {
    const meta = JSON.parse(await readFile(join(item.project, 'meta.json'), 'utf8')) as Meta;
    if (!only || new RegExp(only).test(meta.framework)) items.push({ ...item, meta: { framework: meta.framework, fault: meta.fault, expected: meta.expected } });
  }
}
if (!items.length) refuse(`no apps in ${corpus}${only ? ` matching ${only}` : ''}`);
// A report has every round kept, unless told how many.
const rounds = args.rounds !== undefined ? count('rounds', args.rounds) : ran ? Math.max(...done.map((d) => d.round)) : 1;

/**
 * One pass, in a process of its own, as `sandburg batch` runs: what a process keeps in memory of the
 * stores (the installs it knows, the seeds it ran) would otherwise outlive a cold pass's removal of
 * .sandburg/, and make a warm pass warmer than a batch of its own would be (a library bug:
 * https://github.com/swissspidy/sandburg/issues/117).
 */
function pass(mode: 'cold' | 'warm'): Promise<Pass> {
  const argv = [import.meta.filename, corpus, '--pass', mode, '--parallel', String(parallel), ...(only ? ['--only', only] : [])];
  return readPass<Pass>(spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] }), `the ${mode} pass`);
}

/** One pass in this process: a batch in a fresh session, in the corpus's order, its summaries in a directory of its own. */
async function runPass(mode: 'cold' | 'warm'): Promise<Pass> {
  if (mode === 'cold') await rm('.sandburg', { recursive: true, force: true });
  const batchDir = await mkdtemp(join(tmpdir(), `sandburg-study-${mode}-`));
  const session = new Session();
  await session.open();
  const epoch = Date.now();
  // The machine's CPU use in each 500 ms from the pass's start, to tell how loaded each run's neighbours kept it.
  const timeline: { at: number; cpu: number }[] = [];
  let last = await cpuTicks();
  const sampler = setInterval(() => {
    void cpuTicks().then((now) => {
      if (now && last) timeline.push({ at: Date.now() - epoch, cpu: ((now.busy - last.busy) / (now.total - last.total || 1)) * 100 });
      last = now;
    });
  }, 500);
  let summary;
  let results: RunResult[];
  try {
    ({ summary, results } = await runBatch(session, items, { parallel, batchDir, longestFirst: false, log: (l) => console.error(`  ${l}`) }));
  } finally {
    clearInterval(sampler);
    await session.close();
    await rm(batchDir, { recursive: true, force: true });
  }
  const spans = results.map((r) => [Date.parse(r.startedAt) - epoch, Date.parse(r.finishedAt) - epoch]);
  const runs = results.map((r, i): Run => {
    const [start, end] = spans[i];
    let shared = 0;
    for (const [j, [s, e]] of spans.entries()) if (j !== i) shared += Math.max(0, Math.min(end, e) - Math.max(start, s));
    const during = timeline.filter((t) => t.at > start && t.at <= end + 500).map((t) => t.cpu);
    return {
      app: items[i].label,
      result: r.status === 'passed' ? 'pass' : 'fail',
      failureClass: r.failure?.class ?? null,
      rule: r.failure?.rule ?? null,
      totalMs: Math.round(r.timings.totalMs),
      phases: Object.fromEntries(r.phases.map((p) => [p.name, Math.round(p.durationMs)])),
      startMs: start,
      endMs: end,
      neighbours: end > start ? Math.round((shared / (end - start)) * 100) / 100 : 0,
      cpu: during.length ? Math.round(during.reduce((a, b) => a + b, 0) / during.length) : null,
    };
  });
  return { wallMs: summary.wallMs, runs };
}

if (args.pass) {
  await writePass(await runPass(args.pass === 'cold' ? 'cold' : 'warm'));
  // The session's handles would keep the process open.
  process.exit(0);
}

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();
const params: Params = ran ?? { corpus, apps: items.map((i) => i.label), meta: Object.fromEntries(items.map((i) => [i.label, i.meta])), parallel, only, commit };

/** The first way two passes' parameters differ, or null. */
function mismatch(a: Params, b: Params): string | null {
  if (a.corpus !== b.corpus) return `the corpus (${a.corpus}, not ${b.corpus})`;
  if (a.apps.join('\n') !== b.apps.join('\n')) return `the apps (${a.apps.length} of them, not these ${b.apps.length})`;
  const changed = a.apps.find((app) => JSON.stringify(a.meta[app]) !== JSON.stringify(b.meta[app]));
  if (changed) return `another meta.json of ${changed} (${JSON.stringify(a.meta[changed])}, not ${JSON.stringify(b.meta[changed])})`;
  if (a.parallel !== b.parallel) return `--parallel ${a.parallel}, not ${b.parallel}`;
  if (a.only !== b.only) return `--only ${a.only ?? '(none)'}, not ${b.only ?? '(none)'}`;
  if (a.commit !== b.commit) return `commit ${a.commit ?? '(unknown)'}, not ${b.commit ?? '(unknown)'}`;
  return null;
}

// A study goes on only from passes run as it would run them; a report's passes agree with each other.
for (const d of done) {
  const why = mismatch(d.params, params);
  if (why) refuse(`${kept} holds a ${d.mode} pass (round ${d.round}) run with ${why}: use another --out, or remove it`);
}

const passes = { cold: [] as Pass[], warm: [] as Pass[] };
for (let round = 1; round <= rounds; round++) {
  for (const mode of ['cold', 'warm'] as const) {
    const earlier = done.find((d) => d.round === round && d.mode === mode);
    if (!earlier && args.report) refuse(`${kept} has no ${mode} pass for round ${round}`);
    const p = earlier?.pass ?? (await pass(mode));
    if (kept && !earlier) await appendFile(kept, JSON.stringify({ round, mode, params, pass: p } satisfies Kept) + '\n');
    passes[mode].push(p);
    const passed = p.runs.filter((r) => r.result === 'pass').length;
    console.error(`round ${round} ${mode}: ${(p.wallMs / 1000).toFixed(1)} s, ${passed}/${p.runs.length} passed`);
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Each app's entry: the first round's answer; its time, phases and CPU use, the medians of its passing rounds. */
function apps(mode: 'cold' | 'warm') {
  const byLabel = passes[mode].map((p) => new Map(p.runs.map((r) => [r.app, r])));
  return items.map((item) => {
    const runs = byLabel.map((m, round) => m.get(item.label) ?? refuse(`round ${round + 1}'s ${mode} pass has no run of ${item.label}`));
    const passing = runs.filter((r) => r.result === 'pass');
    const names = [...new Set(passing.flatMap((r) => Object.keys(r.phases)))];
    const { result, failureClass, rule } = runs[0];
    const cpus = passing.flatMap((r) => (r.cpu === null ? [] : [r.cpu]));
    return {
      app: item.label,
      framework: item.meta.framework,
      runtime: 'node',
      fault: item.meta.fault,
      expected: item.meta.expected,
      result,
      failureClass,
      rule,
      passedRounds: passing.length,
      totalMs: passing.length ? median(passing.map((r) => r.totalMs)) : null,
      phases: Object.fromEntries(names.map((name) => [name, median(passing.flatMap((r) => (name in r.phases ? [r.phases[name]] : [])))])),
      neighbours: passing.length ? median(passing.map((r) => r.neighbours)) : null,
      cpu: cpus.length ? median(cpus) : null,
      rounds: runs,
    };
  });
}

const cold = apps('cold');
const warm = apps('warm');
type App = (typeof cold)[number];
const s = (ms: number) => (Number.isNaN(ms) ? '–' : `${(ms / 1000).toFixed(1)} s`);
const pct = (xs: number[]) => (xs.length ? `${Math.round(median(xs))}%` : '–');
const lines = [
  '| Framework | Apps | Right, cold / warm | False alarms, cold / warm | Faults caught, cold / warm | Median, cold → warm | Slower warm (>1.2×) | CPU while it ran, cold / warm |',
  '|---|---|---|---|---|---|---|---|',
];
/** A row over the apps `pick` takes (their indexes in items). */
function row(name: string, pick: (i: number) => boolean) {
  const at = items.map((_, i) => i).filter(pick);
  const right = (list: App[]) => at.filter((i) => list[i].result === list[i].expected).length;
  const alarms = (list: App[]) => at.filter((i) => list[i].expected === 'pass' && list[i].result === 'fail').length;
  const faults = at.filter((i) => items[i].meta.expected === 'fail');
  const caught = (list: App[]) => faults.filter((i) => list[i].result === 'fail').length;
  // The apps that pass in both passes: cold's and warm's medians are of the same apps.
  const both = at.filter((i) => cold[i].expected === 'pass' && cold[i].totalMs !== null && warm[i].totalMs !== null);
  const slower = both.filter((i) => warm[i].totalMs! > 1.2 * cold[i].totalMs!).length;
  const cpu = (list: App[]) => pct(both.flatMap((i) => (list[i].cpu === null ? [] : [list[i].cpu])));
  lines.push(
    `| ${name} | ${at.length} | ${right(cold)} / ${right(warm)} | ${alarms(cold)} / ${alarms(warm)} | ${caught(cold)}/${faults.length} / ${caught(warm)}/${faults.length} | ` +
      `${s(median(both.map((i) => cold[i].totalMs!)))} → ${s(median(both.map((i) => warm[i].totalMs!)))} | ${slower} of ${both.length} | ${cpu(cold)} / ${cpu(warm)} |`,
  );
}
for (const fw of [...new Set(items.map((i) => i.meta.framework))]) row(fw, (i) => items[i].meta.framework === fw);
row('**All**', () => true);

const wall = (mode: 'cold' | 'warm') => median(passes[mode].map((p) => p.wallMs));
const wrong = (mode: 'cold' | 'warm') => passes[mode].reduce((n, p) => n + p.runs.filter((r) => r.result !== items.find((i) => i.label === r.app)!.meta.expected).length, 0);
// Per round: the apps more than 1.2x slower warm than in the same round's cold pass, both passing.
const slowerInRound = passes.cold.flatMap((c, round) => {
  const w = new Map(passes.warm[round].runs.map((r) => [r.app, r]));
  return c.runs.filter((r) => r.result === 'pass' && w.get(r.app)?.result === 'pass' && w.get(r.app)!.totalMs > 1.2 * r.totalMs).map((r) => `${r.app} in round ${round + 1} (${s(r.totalMs)} → ${s(w.get(r.app)!.totalMs)})`);
});
lines.push(
  '',
  `Wall time, cold / warm: ${s(wall('cold'))} / ${s(wall('warm'))} (parallel ${parallel}, ${rounds} round${rounds > 1 ? 's' : ''}, ${items.length} apps).`,
  `Wrong runs over all rounds, cold / warm: ${wrong('cold')} / ${wrong('warm')} of ${rounds * items.length}.`,
  `Runs more than 1.2× slower warm than the same round's cold run: ${slowerInRound.length ? slowerInRound.join(', ') : 'none'}.`,
);
console.log(lines.join('\n'));

if (args.out) {
  const doc = (mode: 'cold' | 'warm', list: App[]) => ({
    generated: new Date().toISOString().slice(0, 10),
    runtime: 'node',
    reference: 'ground truth (meta.expected)',
    pass: mode,
    parallel,
    rounds,
    commit: params.commit,
    order: 'corpus order in both passes (longestFirst: false)',
    times: "an app's totalMs, phases and cpu: the medians of its passing rounds (null if none passed)",
    wallMs: wall(mode),
    apps: list,
  });
  await writeFile(`${args.out}.json`, JSON.stringify(doc('cold', cold), null, 2) + '\n');
  await writeFile(`${args.out}-warm.json`, JSON.stringify(doc('warm', warm), null, 2) + '\n');
}
