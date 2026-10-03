/**
 * App-generation eval: models × stacks × tasks. Each cell does what the generator page does
 * (pages/generate): the same system prompt, scaffold and answer format; the app runs in Sandburg,
 * and errors from the run go back to the model, at most --fixes times. Then the task's checks
 * decide the score. Failing checks are never shown to the model: like the page, it hears only
 * about errors.
 *
 *   ANTHROPIC_API_KEY=… GEMINI_API_KEY=… node evals/app-gen/run.ts \
 *     --models claude-opus-5-5,gemini-3.1-pro-preview --stacks vanilla,react,sveltekit
 *   node evals/app-gen/run.ts --rescore .sandburg/evals/<id>   (run stored apps again, no model)
 *
 * Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1 so Node's fetch uses it.
 */
import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Session, projectFromFiles } from '../../src/index.ts';
import type { FileTree, RunResult } from '../../src/types.ts';
import { applyEdits, parseAnswer } from '../../pages/generate/files.ts';
import { ProviderError, call, type Provider, type Turn } from '../../pages/generate/llm.ts';
import { SYSTEM, firstMessage, fixMessage } from '../../pages/generate/prompt.ts';
import { TEMPLATES } from '../../pages/generate/templates.ts';
import { SUITE, type Task } from './suite.ts';

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'claude-opus-5-5' },
    stacks: { type: 'string', default: 'vanilla,react,sveltekit' },
    tasks: { type: 'string' },
    fixes: { type: 'string', default: '2' },
    parallel: { type: 'string', default: '3' },
    'install-in': { type: 'string', default: 'browser' },
    out: { type: 'string', default: '.sandburg/evals' },
    rescore: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const installIn = values['install-in'] === 'host' ? 'host' : 'browser';
const maxFixes = Number(values.fixes);
const tasks = values.tasks ? SUITE.filter((t) => values.tasks!.split(',').includes(t.id)) : SUITE;

/** Error lines on the dev server's stderr, as the page picks them (pages/generate/main.ts). */
const ERROR_LINE = /\b(error|Error|ERR_|failed|Failed|Cannot find|Could not|not found|Uncaught|SyntaxError|TypeError|ReferenceError)\b/;

interface Attempt {
  kind: 'generate' | 'fix';
  model: string;
  genMs: number;
  tokens: { input: number; output: number };
  stop: string;
  files: string[];
  rejected: string[];
  run: RunSummary | null;
  /** The errors the next fix was asked to fix. */
  errors: string[];
}

interface RunSummary {
  runId: string;
  status: RunResult['status'];
  failure: { class: string; phase: string; rule: string; message: string } | null;
  checks: { name: string; status: string; message?: string }[];
  timings: { installMs: number | null; startMs: number | null; readyMs: number | null; totalMs: number };
  axeViolations: number | null;
}

export interface Cell {
  task: string;
  stack: string;
  model: string;
  attempts: Attempt[];
  final: Score;
  firstTry: Score | null;
  /** Why the cell has no score: the provider failed, or the runtime could not run the app (not the model's fault). */
  excluded: string | null;
  /** The last --rescore run of the stored app, when there was one. */
  rescored?: RunSummary;
}

interface Score {
  passed: boolean;
  checksPassed: number;
  checksTotal: number;
  score: number;
  failureClass: string | null;
}

async function main(): Promise<void> {
  const session = new Session({ headless: !values.headed });
  await session.open();
  try {
    if (values.rescore) return await rescore(session, resolve(values.rescore));
    const models = values.models.split(',').filter(Boolean);
    const stacks = values.stacks.split(',').filter(Boolean);
    for (const s of stacks) if (!TEMPLATES.some((t) => t.id === s)) throw new Error(`unknown stack ${s} (${TEMPLATES.map((t) => t.id).join(', ')})`);
    for (const m of models) keyFor(providerOf(m));

    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = resolve(values.out, id);
    const jobs = models.flatMap((model) => stacks.flatMap((stack) => tasks.map((task) => ({ model, stack, task }))));
    console.error(`${jobs.length} cells (${models.length} models × ${stacks.length} stacks × ${tasks.length} tasks), ${values.parallel} at a time → ${relative(process.cwd(), dir)}`);
    const cells = await pool(jobs, Number(values.parallel), async (job) => {
      const cell = await runCell(session, job.model, job.stack, job.task, join(dir, cellName(job)));
      console.error(line(cell));
      return cell;
    });
    await report(dir, cells);
  } finally {
    await session.close();
  }
}

function cellName(c: { task: Task | string; stack: string; model: string }): string {
  return `${c.model}__${c.stack}__${typeof c.task === 'string' ? c.task : c.task.id}`;
}

async function runCell(session: Session, model: string, stack: string, task: Task, dir: string): Promise<Cell> {
  const tpl = TEMPLATES.find((t) => t.id === stack)!;
  const cell: Cell = { task: task.id, stack, model, attempts: [], final: zero(task), firstTry: null, excluded: null };
  await mkdir(dir, { recursive: true });
  let files: FileTree = { ...tpl.files };
  const turns: Turn[] = [{ role: 'user', text: firstMessage(task.prompt, tpl) }];
  const transcript: string[] = [];
  try {
    for (let i = 0; i <= maxFixes; i++) {
      const started = Date.now();
      const answer = await call({ provider: providerOf(model), model, apiKey: keyFor(providerOf(model)), system: SYSTEM, turns, onText: () => {} });
      turns.push(answer.turn);
      transcript.push(`## ${i === 0 ? 'Request' : `Fix ${i}`}\n\n${turns.at(-2)!.text.slice(0, i === 0 ? 2000 : 6000)}\n\n## Answer (${answer.model})\n\n${answer.turn.text}`);
      const parsed = parseAnswer(answer.turn.text);
      const applied = applyEdits(files, parsed.edits);
      files = applied.files;
      const attempt: Attempt = {
        kind: i === 0 ? 'generate' : 'fix',
        model: answer.model,
        genMs: Date.now() - started,
        tokens: answer.usage,
        stop: answer.stop,
        files: [...applied.changed, ...applied.deleted.map((p) => `-${p}`)],
        rejected: parsed.rejected,
        run: null,
        errors: [],
      };
      cell.attempts.push(attempt);
      if (answer.stop === 'refusal') break;

      const result = await session.run(projectFromFiles(files, { name: cellName({ task, stack, model }), path: dir }), {
        installIn,
        checks: task.checks,
        outDir: join(dir, 'runs'),
      });
      attempt.run = summarize(result);
      cell.final = score(task, result);
      if (i === 0) cell.firstTry = cell.final;
      if (result.failure?.class === 'runtime-unsupported' || result.failure?.class === 'infra') {
        cell.excluded = `${result.failure.class}: ${result.failure.rule}`;
        break;
      }
      if (cell.final.passed) break;
      attempt.errors = errorsOf(result);
      if (!attempt.errors.length || i === maxFixes) break;
      turns.push({ role: 'user', text: fixMessage(attempt.errors, files) });
    }
  } catch (err) {
    cell.excluded = `${err instanceof ProviderError ? 'provider' : 'harness'}: ${(err as Error).message.split('\n')[0]}`;
  }
  await writeFile(join(dir, 'files.json'), JSON.stringify(files, null, 2) + '\n');
  await writeFile(join(dir, 'transcript.md'), transcript.join('\n\n') + '\n');
  await writeFile(join(dir, 'cell.json'), JSON.stringify(cell, null, 2) + '\n');
  return cell;
}

/** What the page would have collected from this run, for the model to fix. */
function errorsOf(r: RunResult): string[] {
  const errors: string[] = [];
  if (r.failure && r.failure.phase !== 'checks') errors.push(`${r.failure.phase} failed: ${r.failure.message}`);
  for (const c of r.console) {
    const m = c.source === 'host' && /^\[runtime:stderr\] ([\s\S]*)$/.exec(c.text);
    if (m && ERROR_LINE.test(m[1])) errors.push(m[1].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim());
    if (c.source === 'app' && c.type === 'error') errors.push(c.text);
  }
  for (const e of r.pageErrors) if (e.source === 'app') errors.push(`Uncaught ${e.message}`);
  const doc = r.checks.find((c) => c.kind === 'document' && c.status === 'failed');
  if (doc?.message) errors.push(doc.message);
  return [...new Set(errors.filter(Boolean))].slice(-40);
}

function score(task: Task, r: RunResult): Score {
  const functional = r.checks.filter((c) => c.kind === 'functional');
  const checksTotal = Object.keys(task.checks).length;
  const checksPassed = functional.filter((c) => c.status === 'passed').length;
  return {
    passed: r.status === 'passed' && checksPassed === checksTotal,
    checksPassed,
    checksTotal,
    score: checksPassed / checksTotal,
    failureClass: r.failure?.class ?? null,
  };
}

function zero(task: Task): Score {
  return { passed: false, checksPassed: 0, checksTotal: Object.keys(task.checks).length, score: 0, failureClass: null };
}

function summarize(r: RunResult): RunSummary {
  const axe = r.checks.find((c) => c.kind === 'axe')?.details as { violations?: unknown[] | number } | undefined;
  return {
    runId: r.runId,
    status: r.status,
    failure: r.failure && { class: r.failure.class, phase: r.failure.phase, rule: r.failure.rule, message: r.failure.message.slice(0, 2000) },
    checks: r.checks.filter((c) => c.kind === 'functional' || c.blocking).map((c) => ({ name: c.name, status: c.status, message: c.message?.split('\n')[0] })),
    timings: { installMs: r.timings.installMs, startMs: r.timings.startMs, readyMs: r.timings.readyMs, totalMs: r.timings.totalMs },
    axeViolations: Array.isArray(axe?.violations) ? axe.violations.length : typeof axe?.violations === 'number' ? axe.violations : null,
  };
}

/** Runs the stored apps of an earlier eval again with the suite's current checks. No model calls. */
async function rescore(session: Session, dir: string): Promise<void> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const cells = await pool(names, Number(values.parallel), async (name) => {
    const cell = JSON.parse(await readFile(join(dir, name, 'cell.json'), 'utf8')) as Cell;
    const task = SUITE.find((t) => t.id === cell.task);
    if (!task || (cell.excluded?.startsWith('provider') ?? false)) return cell;
    const files = JSON.parse(await readFile(join(dir, name, 'files.json'), 'utf8')) as FileTree;
    const result = await session.run(projectFromFiles(files, { name, path: join(dir, name) }), { installIn, checks: task.checks, outDir: join(dir, name, 'runs') });
    cell.final = score(task, result);
    cell.rescored = summarize(result);
    cell.excluded = result.failure?.class === 'runtime-unsupported' || result.failure?.class === 'infra' ? `${result.failure.class}: ${result.failure.rule}` : null;
    await writeFile(join(dir, name, 'cell.json'), JSON.stringify(cell, null, 2) + '\n');
    console.error(line(cell));
    return cell;
  });
  await report(dir, cells);
}

function line(c: Cell): string {
  const tokens = c.attempts.reduce((n, a) => n + a.tokens.output, 0);
  const verdict = c.excluded ? 'EXCL' : c.final.passed ? 'PASS' : 'FAIL';
  return `${verdict} ${c.model} ${c.stack} ${c.task}: ${c.final.checksPassed}/${c.final.checksTotal} checks, ${c.attempts.length - 1} fixes, ${tokens} output tokens${c.excluded ? ` [${c.excluded}]` : c.final.failureClass ? ` [${c.final.failureClass}]` : ''}`;
}

async function report(dir: string, cells: Cell[]): Promise<void> {
  const groups = new Map<string, Cell[]>();
  for (const c of cells) {
    const key = `${c.model}\t${c.stack}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const rows = [...groups].map(([key, cs]) => {
    const [model, stack] = key.split('\t');
    const scored = cs.filter((c) => !c.excluded);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      model,
      stack,
      cells: cs.length,
      excluded: cs.length - scored.length,
      passed: scored.filter((c) => c.final.passed).length,
      passedFirstTry: scored.filter((c) => c.firstTry?.passed).length,
      meanScore: mean(scored.map((c) => c.final.score)),
      fixes: scored.reduce((n, c) => n + c.attempts.length - 1, 0),
      outputTokens: Math.round(mean(scored.map((c) => c.attempts.reduce((n, a) => n + a.tokens.output, 0)))),
      genSeconds: mean(scored.map((c) => c.attempts.reduce((n, a) => n + a.genMs, 0) / 1000)),
      readySeconds: mean(scored.flatMap((c) => c.attempts.filter((a) => a.run).slice(-1).map((a) => (a.run!.timings.totalMs ?? 0) / 1000))),
    };
  });
  const summary = { suite: 'app-gen', installIn, maxFixes, finishedAt: new Date().toISOString(), rows, cells };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const md = [
    '| Model | Stack | Passed | First try | Mean score | Fixes | Output tokens | Generate | Run |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.model} | ${r.stack} | ${r.passed}/${r.cells - r.excluded}${r.excluded ? ` (+${r.excluded} excl.)` : ''} | ${r.passedFirstTry} | ${r.meanScore.toFixed(2)} | ${r.fixes} | ${r.outputTokens} | ${r.genSeconds.toFixed(0)} s | ${r.readySeconds.toFixed(0)} s |`),
    '',
    '| Cell | Checks | Fixes | Failure |',
    '|---|---|---|---|',
    ...cells.map((c) => `| ${cellName(c)} | ${c.final.checksPassed}/${c.final.checksTotal}${c.final.passed ? ' ✓' : ''} | ${c.attempts.length ? c.attempts.length - 1 : '-'} | ${c.excluded ?? failedCheck(c) ?? ''} |`),
  ].join('\n');
  await writeFile(join(dir, 'summary.md'), md + '\n');
  console.log(md);
}

function failedCheck(c: Cell): string | null {
  const run = c.rescored ?? c.attempts.findLast((a) => a.run)?.run;
  if (!run) return null;
  const check = run.checks.find((x) => x.status !== 'passed');
  return check ? `${check.name}: ${(check.message ?? check.status).slice(0, 120).replace(/\|/g, '\\|')}` : run.failure ? `${run.failure.class} [${run.failure.rule}]` : null;
}

function providerOf(model: string): Provider {
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^gemini-/.test(model)) return 'gemini';
  throw new Error(`unknown provider for ${model}`);
}

function keyFor(provider: Provider): string {
  const name = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  const key = process.env[name];
  if (!key) throw new Error(`${name} is not set`);
  return key;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

await main();
