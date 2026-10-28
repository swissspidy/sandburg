/**
 * A fidelity study's cold and warm passes over a corpus (scripts/corpus), with each run's answer
 * compared with the app's ground truth (meta.json's `expected`), and the per-framework table.
 *
 *   node scripts/fidelity-study.ts [corpus] [--parallel 3] [--rounds 1] [--only <regex>] [--out docs/fidelity/vN-node-vs-truth]
 *
 * - cold: the batch starts from empty Sandburg stores (.sandburg/ removed; npm's own download cache
 *   stays as it is). warm: the same apps again, on the stores the cold pass left.
 * - Both passes start the apps in the same order (the corpus's), with the same parallelism, so that
 *   each app runs beside the same neighbours in both. A batch otherwise starts the apps that ran
 *   longest in its earlier batches first (BatchOptions.longestFirst), which only the warm pass has:
 *   in v7 that ran the fast apps last, side by side, and made their warm runs look slower than cold.
 *   Each pass keeps its batch summaries in a directory of its own, so neither reads the other's.
 * - --rounds n runs n cold/warm pairs, one after the other (cold, warm, cold, warm, ...), so that drift
 *   in the machine's load falls on both; an app's time is its median over the rounds, its answer
 *   the first round's (each round's is in `rounds`).
 * - --only: the apps whose framework (meta.json) matches, e.g. 'vue|static|lit'.
 * - --out: writes <out>.json (cold) and <out>-warm.json (warm), each app with its phases, when it
 *   started and ended (ms from its pass's start), and `neighbours`: the mean number of other runs
 *   open while it ran. Per-app times at --parallel above 1 include its neighbours' load: compare
 *   cold with warm per app only where `neighbours` is alike, or at --parallel 1.
 *
 * Set SANDBURG_CHROMIUM to use a Chromium other than Playwright's.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Session } from '../src/index.ts';
import { discoverProjects, runBatch, type BatchItem } from '../src/orchestrator/batch.ts';
import type { RunResult } from '../src/types.ts';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    parallel: { type: 'string', default: '3' },
    rounds: { type: 'string', default: '1' },
    only: { type: 'string' },
    out: { type: 'string' },
  },
});
const corpus = resolve(positionals[0] ?? 'corpus');
const parallel = Number(args.parallel);
const rounds = Number(args.rounds);

interface Meta {
  framework: string;
  fault: string;
  expected: 'pass' | 'fail';
}

interface Run {
  result: 'pass' | 'fail';
  failureClass: string | null;
  rule: string | null;
  totalMs: number;
  phases: Record<string, number>;
  startMs: number;
  endMs: number;
  neighbours: number;
}

const items: (BatchItem & { meta: Meta })[] = [];
for (const item of await discoverProjects(corpus)) {
  const meta = JSON.parse(await readFile(join(item.project, 'meta.json'), 'utf8')) as Meta;
  if (!args.only || new RegExp(args.only).test(meta.framework)) items.push({ ...item, meta });
}
if (!items.length) throw new Error(`no apps in ${corpus}${args.only ? ` matching ${args.only}` : ''}`);

/** One pass: a batch in a fresh session, in the corpus's order, its summaries in a directory of its own. */
async function pass(mode: 'cold' | 'warm'): Promise<{ wallMs: number; runs: Run[] }> {
  if (mode === 'cold') await rm('.sandburg', { recursive: true, force: true });
  const batchDir = await mkdtemp(join(tmpdir(), `sandburg-study-${mode}-`));
  const session = new Session();
  await session.open();
  const epoch = Date.now();
  let summary;
  let results: RunResult[];
  try {
    ({ summary, results } = await runBatch(session, items, { parallel, batchDir, longestFirst: false, log: (l) => console.error(`  ${l}`) }));
  } finally {
    await session.close();
    await rm(batchDir, { recursive: true, force: true });
  }
  const spans = results.map((r) => [Date.parse(r.startedAt) - epoch, Date.parse(r.finishedAt) - epoch]);
  const runs = results.map((r, i): Run => {
    const [start, end] = spans[i];
    let shared = 0;
    for (const [j, [s, e]] of spans.entries()) if (j !== i) shared += Math.max(0, Math.min(end, e) - Math.max(start, s));
    return {
      result: r.status === 'passed' ? 'pass' : 'fail',
      failureClass: r.failure?.class ?? null,
      rule: r.failure?.rule ?? null,
      totalMs: Math.round(r.timings.totalMs),
      phases: Object.fromEntries(r.phases.map((p) => [p.name, Math.round(p.durationMs)])),
      startMs: start,
      endMs: end,
      neighbours: end > start ? Math.round((shared / (end - start)) * 100) / 100 : 0,
    };
  });
  return { wallMs: summary.wallMs, runs };
}

const passes = { cold: [] as Awaited<ReturnType<typeof pass>>[], warm: [] as Awaited<ReturnType<typeof pass>>[] };
for (let round = 1; round <= rounds; round++) {
  for (const mode of ['cold', 'warm'] as const) {
    const p = await pass(mode);
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

/** Each app's entry: the first round's answer, the median time and phases over the rounds. */
function apps(mode: 'cold' | 'warm') {
  return items.map((item, i) => {
    const runs = passes[mode].map((p) => p.runs[i]);
    const phases = Object.fromEntries(Object.keys(runs[0].phases).map((name) => [name, median(runs.map((r) => r.phases[name] ?? 0))]));
    const { result, failureClass, rule } = runs[0];
    return {
      app: item.label,
      framework: item.meta.framework,
      runtime: 'node',
      fault: item.meta.fault,
      expected: item.meta.expected,
      result,
      failureClass,
      rule,
      totalMs: median(runs.map((r) => r.totalMs)),
      phases,
      neighbours: median(runs.map((r) => r.neighbours)),
      rounds: runs,
    };
  });
}

const cold = apps('cold');
const warm = apps('warm');
const lines = ['| Framework | Apps | Right, cold / warm | False alarms, cold / warm | Median passing, cold | Median passing, warm | Neighbours, cold / warm |', '|---|---|---|---|---|---|---|'];
const s = (ms: number) => (Number.isNaN(ms) ? '–' : `${(ms / 1000).toFixed(1)} s`);
for (const fw of [...new Set(items.map((i) => i.meta.framework))]) {
  const of = (list: typeof cold) => list.filter((a) => a.framework === fw);
  const right = (list: typeof cold) => of(list).filter((a) => a.result === a.expected).length;
  const alarms = (list: typeof cold) => of(list).filter((a) => a.expected === 'pass' && a.result === 'fail').length;
  const passing = (list: typeof cold) => median(of(list).filter((a) => a.expected === 'pass' && a.result === 'pass').map((a) => a.totalMs));
  const near = (list: typeof cold) => median(of(list).map((a) => a.neighbours)).toFixed(1);
  lines.push(`| ${fw} | ${of(cold).length} | ${right(cold)} / ${right(warm)} | ${alarms(cold)} / ${alarms(warm)} | ${s(passing(cold))} | ${s(passing(warm))} | ${near(cold)} / ${near(warm)} |`);
}
const wall = (mode: 'cold' | 'warm') => median(passes[mode].map((p) => p.wallMs));
lines.push('', `Wall time, cold / warm: ${s(wall('cold'))} / ${s(wall('warm'))} (parallel ${parallel}, ${rounds} round${rounds > 1 ? 's' : ''}, ${items.length} apps)`);
console.log(lines.join('\n'));

if (args.out) {
  const doc = (mode: 'cold' | 'warm', list: typeof cold) => ({
    generated: new Date().toISOString().slice(0, 10),
    runtime: 'node',
    reference: 'ground truth (meta.expected)',
    pass: mode,
    parallel,
    rounds,
    order: 'corpus order in both passes (longestFirst: false)',
    wallMs: wall(mode),
    apps: list,
  });
  await writeFile(`${args.out}.json`, JSON.stringify(doc('cold', cold), null, 2) + '\n');
  await writeFile(`${args.out}-warm.json`, JSON.stringify(doc('warm', warm), null, 2) + '\n');
}
