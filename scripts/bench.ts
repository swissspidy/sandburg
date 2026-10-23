/**
 * A/B benchmark of two revisions: runs fixtures in fresh sessions, interleaved (the order alternates
 * each round, so drift in the machine's load falls on both), and prints the medians per fixture, mode
 * and phase, with the change from base to head.
 *
 *   node scripts/bench.ts [--base origin/main] [--head .] [--fixtures vite-react-counter,lit-vite,next-app-router]
 *                         [--modes cold,warm] [--rounds 3] [--json out.jsonl] [--summary out.md] [--fail-above 0.3]
 *
 * - A revision is a git ref, checked out in a worktree under the temporary directory (its
 *   node_modules is this checkout's when the lockfiles match, else npm ci), or `.` for this
 *   checkout as it is (cold runs remove its .sandburg/).
 * - cold: a fresh session in a revision whose .sandburg/ was removed (npm's own cache stays warm);
 *   the time to the result, then Session.close (a seed run may finish then) separately.
 * - warm: a fresh session runs the fixture twice; the second run is measured.
 * - --fail-above 0.3 exits 1 when head's median total is more than 30% above base's for any
 *   fixture and mode, or when either has no result (for CI, where runners are noisy: only large
 *   regressions are worth a red job).
 *
 * Set SANDBURG_CHROMIUM to use a Chromium other than Playwright's.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string', default: '.' },
    fixtures: { type: 'string', default: 'vite-react-counter,lit-vite,next-app-router' },
    modes: { type: 'string', default: 'cold,warm' },
    rounds: { type: 'string', default: '3' },
    json: { type: 'string' },
    summary: { type: 'string' },
    'fail-above': { type: 'string' },
    timeout: { type: 'string', default: '900' },
  },
});

const root = resolve(import.meta.dirname, '..');
const fixtures = args.fixtures.split(',').filter(Boolean);
const modes = args.modes.split(',').filter(Boolean) as ('cold' | 'warm')[];
const rounds = Number(args.rounds);

/** One measurement, in a child process so that each starts from a fresh Node. */
const RUNNER = `
import { join } from 'node:path';
const [wt, fixture, mode] = process.argv.slice(2);
process.chdir(wt);
const { Session } = await import(join(wt, 'src/index.ts'));
const dir = join(wt, 'fixtures', fixture);
const opts = { checks: join(dir, 'checks.spec.ts') };
const session = new Session();
await session.open();
if (mode === 'warm') await session.run(dir, opts);
const t0 = performance.now();
const r = await session.run(dir, opts);
const total = performance.now() - t0;
const t1 = performance.now();
await session.close();
const close = performance.now() - t1;
const phases = Object.fromEntries(r.phases.map((p) => [p.name, Math.round(p.durationMs)]));
console.log('BENCH ' + JSON.stringify({ status: r.status, total: Math.round(total), close: Math.round(close), phases }));
`;
const runner = join(tmpdir(), `sandburg-bench-${process.pid}.ts`);
writeFileSync(runner, RUNNER);

function git(...a: string[]): string {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
}

/** A directory holding the revision, ready to run. */
function checkout(ref: string): { dir: string; label: string } {
  if (ref === '.') return { dir: root, label: `. (${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '+dirty' : ''})` };
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
  // Not under this checkout's .sandburg/, which a cold run of `.` removes.
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
  return { dir, label: `${ref} (${sha.slice(0, 7)})` };
}

interface Sample {
  variant: 'base' | 'head';
  fixture: string;
  mode: string;
  round: number;
  status: string;
  total: number;
  close: number;
  phases: Record<string, number>;
}

function measure(dir: string, fixture: string, mode: 'cold' | 'warm'): Omit<Sample, 'variant' | 'fixture' | 'mode' | 'round'> | null {
  if (mode === 'cold') rmSync(join(dir, '.sandburg'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [runner, dir, fixture, mode], { encoding: 'utf8', timeout: Number(args.timeout) * 1000, env: process.env });
  const line = r.stdout?.split('\n').find((l) => l.startsWith('BENCH '));
  if (!line) {
    console.error(`  ${fixture} ${mode}: no result (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})\n${(r.stderr ?? '').split('\n').slice(-15).join('\n')}`);
    return null;
  }
  return JSON.parse(line.slice(6));
}

const variants = { base: checkout(args.base), head: checkout(args.head) };
if (variants.base.dir === variants.head.dir) throw new Error('base and head are the same checkout');
console.error(`base: ${variants.base.label}\nhead: ${variants.head.label}`);

const samples: Sample[] = [];
for (let round = 1; round <= rounds; round++) {
  const order: ('base' | 'head')[] = round % 2 ? ['base', 'head'] : ['head', 'base'];
  for (const fixture of fixtures) {
    for (const mode of modes) {
      for (const variant of order) {
        const m = measure(variants[variant].dir, fixture, mode);
        if (!m) continue;
        const s: Sample = { variant, fixture, mode, round, ...m };
        samples.push(s);
        console.error(`  round ${round} ${variant} ${fixture} ${mode}: ${s.status} ${(s.total / 1000).toFixed(1)} s`);
        if (args.json) appendFileSync(args.json, JSON.stringify(s) + '\n');
      }
    }
  }
}
rmSync(runner, { force: true });

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sec = (ms: number) => (Number.isNaN(ms) ? '–' : `${(ms / 1000).toFixed(2)} s`);
const pct = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) || !a ? '–' : `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`);

const lines = [`Benchmark: base ${variants.base.label} vs head ${variants.head.label}, ${rounds} rounds, medians.`, '', '| Fixture | Mode | Metric | Base | Head | Change |', '|---|---|---|---|---|---|'];
const regressions: string[] = [];
for (const fixture of fixtures) {
  for (const mode of modes) {
    const of = (v: 'base' | 'head') => samples.filter((s) => s.variant === v && s.fixture === fixture && s.mode === mode);
    const [b, h] = [of('base'), of('head')];
    const failed = [...b, ...h].filter((s) => s.status !== 'passed').length;
    const metric = (name: string, pick: (s: Sample) => number | undefined) => {
      const bm = median(b.map(pick).filter((x): x is number => x !== undefined));
      const hm = median(h.map(pick).filter((x): x is number => x !== undefined));
      lines.push(`| ${fixture} | ${mode} | ${name} | ${sec(bm)} | ${sec(hm)} | ${pct(bm, hm)} |`);
      return [bm, hm];
    };
    const [bt, ht] = metric(`**total**${failed ? ` (${failed} not passed)` : ''}`, (s) => s.total);
    if (mode === 'cold') metric('close', (s) => s.close);
    const phases = [...new Set([...b, ...h].flatMap((s) => Object.keys(s.phases)))];
    for (const p of phases) metric(p, (s) => s.phases[p]);
    const limit = args['fail-above'] ? Number(args['fail-above']) : Infinity;
    if (Number.isNaN(bt) || Number.isNaN(ht)) regressions.push(`${fixture} ${mode}: no result for ${Number.isNaN(bt) ? 'base' : 'head'}`);
    else if (ht > bt * (1 + limit)) regressions.push(`${fixture} ${mode}: ${sec(bt)} -> ${sec(ht)}`);
  }
}
const table = lines.join('\n');
console.log(table);
if (args.summary) appendFileSync(args.summary, table + '\n');
if (regressions.length) {
  console.error(`\nFailed${args['fail-above'] ? ` (regressions above ${Number(args['fail-above']) * 100}%, or no result)` : ' (no result)'}:\n${regressions.join('\n')}`);
  process.exit(1);
}
