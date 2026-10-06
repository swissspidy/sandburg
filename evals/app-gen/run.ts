/**
 * App-generation eval: models × stacks × tasks. Each cell does what the generator page does
 * (pages/generate): the same system prompt, scaffold and answer format; the app runs in Sandburg,
 * and errors from the run go back to the model, at most --fixes times. Then the task's checks
 * decide the score. Failing checks are never shown to the model: like the page, it hears only
 * about errors.
 *
 * A task can have a follow-up request: once the app passes, the model gets it in the same
 * conversation, as a visitor's next request on the page. The changed app runs again with the
 * database its first run left behind, as the page keeps it across a restart, and the follow-up's
 * checks decide whether the change works and the earlier data survived it.
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
import type { Checks } from '../../src/index.ts';
import { applyEdits, DATA_FILES, needsRestart, parseAnswer } from '../../pages/generate/files.ts';
import { ProviderError, call, type Provider, type Turn } from '../../pages/generate/llm.ts';
import { SYSTEM, firstMessage, fixMessage } from '../../pages/generate/prompt.ts';
import { TEMPLATES } from '../../pages/generate/templates.ts';
import { SUITE, type Task } from './suite.ts';

const { values } = parseArgs({
  options: {
    models: { type: 'string', default: 'claude-opus-5-5' },
    stacks: { type: 'string', default: 'vanilla,react,sveltekit,nextjs,nuxt,angular' },
    tasks: { type: 'string' },
    fixes: { type: 'string', default: '2' },
    parallel: { type: 'string', default: '3' },
    'install-in': { type: 'string', default: 'browser' },
    out: { type: 'string', default: '.sandburg/evals' },
    rescore: { type: 'string' },
    report: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const installIn = values['install-in'] === 'host' ? 'host' : 'browser';
const maxFixes = integerOption('--fixes', values.fixes, 0);
const parallel = integerOption('--parallel', values.parallel, 1);
const tasks = values.tasks ? values.tasks.split(',').filter(Boolean).map(taskById) : SUITE;

function integerOption(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!value.trim() || !Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${value}"`);
  return n;
}

function taskById(id: string): Task {
  const task = SUITE.find((t) => t.id === id);
  if (!task) throw new Error(`unknown task ${id} (${SUITE.map((t) => t.id).join(', ')})`);
  return task;
}

/** Error lines on the dev server's stderr, as the page picks them (pages/generate/main.ts). */
const ERROR_LINE = /\b(error|Error|ERR_|failed|Failed|Cannot find|Could not|not found|Uncaught|SyntaxError|TypeError|ReferenceError)\b/;

interface Attempt {
  kind: 'generate' | 'edit' | 'fix';
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

/** One request and the fixes after it. */
interface Stage {
  attempts: Attempt[];
  final: Score;
  firstTry: Score | null;
  /** Why the stage has no score: the provider failed, or the runtime could not run the app (not the model's fault). */
  excluded: string | null;
  /** The last --rescore run of the stored app, when there was one. */
  rescored?: RunSummary;
}

/** The follow-up request. */
interface Edit extends Stage {
  /** Why it did not run: the first request's app did not pass. */
  skipped: string | null;
  /**
   * Whether the generator page would have written the first answer's change into the running app
   * (its dev server reloads it) rather than starting the app again (needsRestart).
   */
  live: boolean | null;
  /** The database files carried over from the first request's last run. */
  dataFiles: string[];
}

/** The first request is the cell's own stage; the follow-up, if the task has one, is `edit`. */
export interface Cell extends Stage {
  task: string;
  stack: string;
  model: string;
  edit?: Edit;
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
    if (values.report) return await report(resolve(values.report), await readCells(resolve(values.report)));
    const models = values.models.split(',').filter(Boolean);
    const stacks = values.stacks.split(',').filter(Boolean);
    for (const s of stacks) if (!TEMPLATES.some((t) => t.id === s)) throw new Error(`unknown stack ${s} (${TEMPLATES.map((t) => t.id).join(', ')})`);
    for (const m of models) keyFor(providerOf(m));

    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = resolve(values.out, id);
    const jobs = models.flatMap((model) => stacks.flatMap((stack) => tasks.map((task) => ({ model, stack, task }))));
    console.error(`${jobs.length} cells (${models.length} models × ${stacks.length} stacks × ${tasks.length} tasks), ${parallel} at a time → ${relative(process.cwd(), dir)}`);
    const cells = await pool(jobs, parallel, async (job) => {
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

/** The conversation and the project as they stand. */
interface Conversation {
  model: string;
  turns: Turn[];
  files: FileTree;
  transcript: string[];
}

async function runCell(session: Session, model: string, stack: string, task: Task, dir: string): Promise<Cell> {
  const tpl = TEMPLATES.find((t) => t.id === stack)!;
  const cell: Cell = { task: task.id, stack, model, ...newStage(task.checks) };
  await mkdir(dir, { recursive: true });
  const conv: Conversation = { model, turns: [{ role: 'user', text: firstMessage(task.prompt, tpl) }], files: { ...tpl.files }, transcript: [] };
  const name = cellName({ task, stack, model });
  const data = await runStage(session, conv, cell, { name, dir, checks: task.checks, data: {}, kind: 'generate' });
  await writeFile(join(dir, 'files.json'), JSON.stringify(conv.files, null, 2) + '\n');
  if (data) await writeFile(join(dir, 'data.json'), JSON.stringify(data) + '\n');

  if (task.followUp) {
    const edit: Edit = { ...newStage(task.followUp.checks), skipped: null, live: null, dataFiles: Object.keys(data ?? {}) };
    cell.edit = edit;
    if (cell.excluded || !cell.final.passed) edit.skipped = 'the first request did not pass';
    else {
      conv.turns.push({ role: 'user', text: task.followUp.prompt });
      await runStage(session, conv, edit, { name: `${name}__edit`, dir, checks: task.followUp.checks, data: data ?? {}, kind: 'edit', stack });
      await writeFile(join(dir, 'files-edit.json'), JSON.stringify(conv.files, null, 2) + '\n');
    }
  }
  await writeFile(join(dir, 'transcript.md'), conv.transcript.join('\n\n') + '\n');
  await writeFile(join(dir, 'cell.json'), JSON.stringify(cell, null, 2) + '\n');
  return cell;
}

/** The model's answer. A dropped connection, a rate limit or a server error gets one more try; a second failure is the provider's. */
async function ask(options: Parameters<typeof call>[0]): Promise<Awaited<ReturnType<typeof call>>> {
  const retryable = (err: unknown) => (err instanceof ProviderError ? err.status === 429 || err.status >= 500 : err instanceof TypeError);
  try {
    return await call(options);
  } catch (err) {
    if (!retryable(err)) throw err instanceof ProviderError ? err : new ProviderError((err as Error).message, 0);
    await new Promise((r) => setTimeout(r, 10_000));
    return await call(options).catch((e: unknown) => {
      throw e instanceof ProviderError ? e : new ProviderError((e as Error).message, 0);
    });
  }
}

function newStage(checks: Checks): Stage {
  return { attempts: [], final: zero(checks), firstTry: null, excluded: null };
}

/**
 * Asks the model (the conversation ends with the request), runs the app with `data` mounted over
 * its files, and sends the errors back until it passes or runs out of fixes. Returns the database
 * files of the last run, as it left them.
 */
async function runStage(
  session: Session,
  conv: Conversation,
  stage: Stage | Edit,
  o: { name: string; dir: string; checks: Checks; data: FileTree; kind: 'generate' | 'edit'; stack?: string },
): Promise<FileTree | null> {
  let data: FileTree | null = null;
  try {
    for (let i = 0; i <= maxFixes; i++) {
      const started = Date.now();
      const provider = providerOf(conv.model);
      const answer = await ask({ provider, model: conv.model, apiKey: keyFor(provider), system: SYSTEM, turns: conv.turns, onText: () => {} });
      conv.turns.push(answer.turn);
      const title = i > 0 ? `Fix ${i}` : o.kind === 'edit' ? 'Follow-up request' : 'Request';
      conv.transcript.push(`## ${title}\n\n${conv.turns.at(-2)!.text.slice(0, o.kind === 'generate' && i === 0 ? 2000 : 6000)}\n\n## Answer (${answer.model})\n\n${answer.turn.text}`);
      const parsed = parseAnswer(answer.turn.text);
      const applied = applyEdits(conv.files, parsed.edits);
      conv.files = applied.files;
      if (i === 0 && o.kind === 'edit' && o.stack) (stage as Edit).live = !needsRestart(applied.changed, applied.deleted, o.stack);
      const attempt: Attempt = {
        kind: i > 0 ? 'fix' : o.kind,
        model: answer.model,
        genMs: Date.now() - started,
        tokens: answer.usage,
        stop: answer.stop,
        files: [...applied.changed, ...applied.deleted.map((p) => `-${p}`)],
        rejected: parsed.rejected,
        run: null,
        errors: [],
      };
      stage.attempts.push(attempt);
      if (answer.stop === 'refusal') break;

      data = null;
      const result = await session.run(projectFromFiles({ ...conv.files, ...o.data }, { name: o.name, path: o.dir }), {
        installIn,
        checks: o.checks,
        outDir: join(o.dir, 'runs'),
        collectFiles: DATA_FILES,
        onAppFiles: (files) => (data = files),
      });
      attempt.run = summarize(result);
      stage.final = score(o.checks, result);
      if (i === 0) stage.firstTry = stage.final;
      if (result.failure?.class === 'runtime-unsupported' || result.failure?.class === 'infra') {
        stage.excluded = `${result.failure.class}: ${result.failure.rule}`;
        break;
      }
      if (stage.final.passed) break;
      attempt.errors = errorsOf(result);
      if (!attempt.errors.length || i === maxFixes) break;
      conv.turns.push({ role: 'user', text: fixMessage(attempt.errors, conv.files) });
    }
  } catch (err) {
    stage.excluded = `${err instanceof ProviderError ? 'provider' : 'harness'}: ${(err as Error).message.split('\n')[0]}`;
  }
  return data;
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

function score(checks: Checks, r: RunResult): Score {
  const functional = r.checks.filter((c) => c.kind === 'functional');
  const checksTotal = Object.keys(checks).length;
  const checksPassed = functional.filter((c) => c.status === 'passed').length;
  return {
    passed: r.status === 'passed' && checksPassed === checksTotal,
    checksPassed,
    checksTotal,
    score: checksPassed / checksTotal,
    failureClass: r.failure?.class ?? null,
  };
}

function zero(checks: Checks): Score {
  return { passed: false, checksPassed: 0, checksTotal: Object.keys(checks).length, score: 0, failureClass: null };
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
  const cells = await pool(names, parallel, async (name) => {
    const cell = JSON.parse(await readFile(join(dir, name, 'cell.json'), 'utf8')) as Cell;
    const task = SUITE.find((t) => t.id === cell.task);
    if (!task || (cell.excluded?.startsWith('provider') ?? false)) return cell;
    const files = JSON.parse(await readFile(join(dir, name, 'files.json'), 'utf8')) as FileTree;
    const data = await rescoreStage(session, cell, files, {}, task.checks, name, join(dir, name));
    const edited = await readFile(join(dir, name, 'files-edit.json'), 'utf8').then((t) => JSON.parse(t) as FileTree, () => null);
    if (task.followUp && cell.edit && edited) {
      if (!cell.final.passed || cell.excluded) [cell.edit.skipped, cell.edit.excluded] = ['the first request did not pass', null];
      else {
        cell.edit.skipped = null;
        cell.edit.dataFiles = Object.keys(data ?? {});
        await rescoreStage(session, cell.edit, edited, data ?? {}, task.followUp.checks, `${name}__edit`, join(dir, name));
      }
    }
    await writeFile(join(dir, name, 'cell.json'), JSON.stringify(cell, null, 2) + '\n');
    console.error(line(cell));
    return cell;
  });
  await report(dir, cells);
}

async function rescoreStage(session: Session, stage: Stage, files: FileTree, data: FileTree, checks: Checks, name: string, dir: string): Promise<FileTree | null> {
  let collected: FileTree | null = null;
  const result = await session.run(projectFromFiles({ ...files, ...data }, { name, path: dir }), {
    installIn,
    checks,
    outDir: join(dir, 'runs'),
    collectFiles: DATA_FILES,
    onAppFiles: (f) => (collected = f),
  });
  stage.final = score(checks, result);
  stage.rescored = summarize(result);
  stage.excluded = result.failure?.class === 'runtime-unsupported' || result.failure?.class === 'infra' ? `${result.failure.class}: ${result.failure.rule}` : null;
  return collected;
}

async function readCells(dir: string): Promise<Cell[]> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const cells = await Promise.all(names.map((n) => readFile(join(dir, n, 'cell.json'), 'utf8').then((t) => JSON.parse(t) as Cell, () => null)));
  return cells.filter((c) => c !== null);
}

/**
 * Why the first failing check of the cell's last run failed: the app has no element with the name
 * the task asked for (or more than one), or the element is there and shows the wrong text or state.
 * Later checks often fail because the first did, so only the first counts.
 */
async function firstMiss(dir: string, c: Cell, stage: Stage): Promise<'element' | 'output' | null> {
  const run = stage.rescored ?? stage.attempts.findLast((a) => a.run)?.run;
  if (!run || stage.final.passed || stage.excluded) return null;
  try {
    const r = JSON.parse(await readFile(join(dir, cellName(c), 'runs', run.runId, 'result.json'), 'utf8')) as RunResult;
    const check = r.checks.find((x) => x.kind === 'functional' && x.status !== 'passed');
    if (!check) return null;
    return /element\(s\) not found|resolved to 0 elements|strict mode violation|waiting for (?:getBy|locator)[^\n]*\n*$/.test(check.message ?? '') ? 'element' : 'output';
  } catch {
    return null;
  }
}

/** Whether the follow-up ran and has a score. */
function editRan(c: Cell): c is Cell & { edit: Edit } {
  return !!c.edit && !c.edit.skipped && !c.edit.excluded;
}

function line(c: Cell): string {
  const stages: Stage[] = c.edit ? [c, c.edit] : [c];
  const tokens = stages.reduce((n, st) => n + st.attempts.reduce((m, a) => m + a.tokens.output, 0), 0);
  // A follow-up the runtime could not run (or the provider failed) is excluded, not failed; a skipped one is the first request's failure.
  const verdict = c.excluded || (c.edit?.excluded && !c.edit.skipped) ? 'EXCL' : c.final.passed && (!c.edit || (editRan(c) && c.edit.final.passed)) ? 'PASS' : 'FAIL';
  const fixes = stages.reduce((n, st) => n + Math.max(st.attempts.length - 1, 0), 0);
  return `${verdict} ${c.model} ${c.stack} ${c.task}: ${c.final.checksPassed}/${c.final.checksTotal} checks, edit ${editCell(c)}, ${fixes} fixes, ${tokens} output tokens${c.excluded ? ` [${c.excluded}]` : c.final.failureClass ? ` [${c.final.failureClass}]` : ''}`;
}

/** The follow-up in a few words: its checks and how the page would have applied it. */
function editCell(c: Cell): string {
  const e = c.edit;
  if (!e) return '-';
  if (e.skipped) return 'skipped';
  if (e.excluded) return e.excluded;
  return `${e.final.checksPassed}/${e.final.checksTotal}${e.final.passed ? ' ✓' : ''}${e.live === null ? '' : e.live ? ' (live)' : ' (restart)'}`;
}

async function report(dir: string, cells: Cell[]): Promise<void> {
  const misses = new Map(await Promise.all(cells.map(async (c) => [c, await firstMiss(dir, c, c)] as const)));
  const editMisses = new Map(await Promise.all(cells.map(async (c) => [c, c.edit && !c.edit.skipped ? await firstMiss(dir, c, c.edit) : null] as const)));
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
      missingElement: scored.filter((c) => misses.get(c) === 'element').length,
      wrongOutput: scored.filter((c) => misses.get(c) === 'output').length,
      meanScore: mean(scored.map((c) => c.final.score)),
      fixes: scored.reduce((n, c) => n + c.attempts.length - 1 + Math.max((c.edit?.attempts.length ?? 0) - 1, 0), 0),
      editsRun: cs.filter(editRan).length,
      editsPassed: cs.filter(editRan).filter((c) => c.edit.final.passed).length,
      editsLive: cs.filter(editRan).filter((c) => c.edit.live).length,
      outputTokens: Math.round(mean(scored.map((c) => [...c.attempts, ...(c.edit?.attempts ?? [])].reduce((n, a) => n + a.tokens.output, 0)))),
      genSeconds: mean(scored.map((c) => [...c.attempts, ...(c.edit?.attempts ?? [])].reduce((n, a) => n + a.genMs, 0) / 1000)),
      readySeconds: mean(scored.flatMap((c) => c.attempts.filter((a) => a.run).slice(-1).map((a) => (a.run!.timings.totalMs ?? 0) / 1000))),
    };
  });
  // A --rescore changes the final scores only: the first try keeps the checks of the original run.
  const summary = { suite: 'app-gen', firstTryBasis: 'checks of the original run', installIn, maxFixes, finishedAt: new Date().toISOString(), rows, cells };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const md = [
    '| Model | Stack | Passed | First try (original checks) | Mean score | Failed: missing element / wrong output | Follow-up passed | Follow-up live | Fixes | Output tokens | Generate | Run |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.model} | ${r.stack} | ${r.passed}/${r.cells - r.excluded}${r.excluded ? ` (+${r.excluded} excl.)` : ''} | ${r.passedFirstTry} | ${r.meanScore.toFixed(2)} | ${r.missingElement} / ${r.wrongOutput} | ${r.editsPassed}/${r.editsRun} | ${r.editsLive}/${r.editsRun} | ${r.fixes} | ${r.outputTokens} | ${r.genSeconds.toFixed(0)} s | ${r.readySeconds.toFixed(0)} s |`),
    '',
    '| Cell | Checks | Follow-up | Fixes | Failure |',
    '|---|---|---|---|---|',
    ...cells.map((c) => `| ${cellName(c)} | ${c.final.checksPassed}/${c.final.checksTotal}${c.final.passed ? ' ✓' : ''} | ${editCell(c)} | ${c.attempts.length ? c.attempts.length - 1 : '-'}${c.edit?.attempts.length ? ` + ${c.edit.attempts.length - 1}` : ''} | ${failureCell(c, misses.get(c) ?? null, editMisses.get(c) ?? null)} |`),
  ].join('\n');
  await writeFile(join(dir, 'summary.md'), md + '\n');
  console.log(md);
}

/** Why the cell failed: the first request's failure, else the follow-up's. */
function failureCell(c: Cell, miss: 'element' | 'output' | null, editMiss: 'element' | 'output' | null): string {
  if (c.excluded) return c.excluded;
  const label = (m: 'element' | 'output' | null) => m && `(${m === 'element' ? 'missing element' : 'wrong output'})`;
  const first = failedCheck(c);
  if (first) return [label(miss), first].filter(Boolean).join(' ');
  if (c.edit && editRan(c)) {
    const edit = failedCheck(c.edit);
    if (edit) return ['follow-up:', label(editMiss), edit].filter(Boolean).join(' ');
  }
  return '';
}

function failedCheck(stage: Stage): string | null {
  const run = stage.rescored ?? stage.attempts.findLast((a) => a.run)?.run;
  if (!run || stage.final.passed) return null;
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
