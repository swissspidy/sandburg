/**
 * The app-gen suite's checks on an eval run's apps, run on the host (Playwright) and in the page
 * (--checks-in page: ivya and user-event), each check's status side by side (ADR 0023).
 *
 *   node evals/app-gen/compare-checks-in.ts <eval run dir> [--model claude-opus-5-5] [--parallel 3]
 *     [--out .sandburg/compare-checks-in.json]
 *
 * Every cell of the model is run twice per step (its request, and its follow-up with the database
 * the request's checks left), on the same app. The suite's checks are bundled into one module for
 * the page: it imports its helpers, and a checks file that runs in the page imports nothing.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { Session } from '../../src/orchestrator/session.ts';
import { projectFromFiles } from '../../src/project.ts';
import type { PageChecks } from '../../src/page-checks/index.ts';
import type { FileTree, RunResult } from '../../src/types.ts';
import { SUITE } from './suite.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', default: 'claude-opus-5-5' },
    parallel: { type: 'string', default: '3' },
    out: { type: 'string', default: '.sandburg/compare-checks-in.json' },
  },
});
const [runDir] = positionals;
if (!runDir) throw new Error('usage: compare-checks-in.ts <eval run dir> [--model m] [--parallel n] [--out file]');

async function pageChecks(taskId: string, followUp: boolean): Promise<PageChecks> {
  const entry = `import { SUITE } from './suite.ts';\nexport default SUITE.find((t) => t.id === ${JSON.stringify(taskId)})${followUp ? '.followUp' : ''}.checks;\n`;
  const built = await esbuild.build({ stdin: { contents: entry, loader: 'ts', resolveDir: here }, bundle: true, format: 'esm', write: false, platform: 'browser', target: 'es2022' });
  return { kind: 'page', file: `${taskId}${followUp ? '.follow-up' : ''}.ts`, code: built.outputFiles[0].text };
}

interface Job {
  cell: string;
  task: string;
  stack: string;
  step: 'request' | 'follow-up';
  files: FileTree;
}
const jobs: Job[] = [];
for (const name of (await readdir(runDir)).sort()) {
  if (!name.startsWith(`${values.model}__`)) continue;
  const dir = join(runDir, name);
  const [, stack, task] = name.split('__');
  const read = async (f: string) => JSON.parse(await readFile(join(dir, f), 'utf8')) as FileTree;
  jobs.push({ cell: name, task, stack, step: 'request', files: await read('files.json') });
  if (existsSync(join(dir, 'files-edit.json'))) {
    jobs.push({ cell: name, task, stack, step: 'follow-up', files: { ...(await read('files-edit.json')), ...(await read('data.json')) } });
  }
}

type Statuses = Record<string, { status: string; message?: string }>;
const functional = (r: RunResult): Statuses =>
  Object.fromEntries(r.checks.filter((c) => c.kind === 'functional').map((c) => [c.name, { status: c.status, message: c.message?.split('\n').slice(0, 6).join(' | ') }]));

const outDir = resolve('.sandburg/compare-runs');
const session = new Session();
await session.open();
const rows: { cell: string; step: string; host: { status: string; checks: Statuses }; page: { status: string; checks: Statuses } }[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const job = jobs[next++];
    const task = SUITE.find((t) => t.id === job.task)!;
    const followUp = job.step === 'follow-up';
    const project = () => projectFromFiles(job.files, { name: `${job.cell}-${job.step}`, path: job.cell });
    const host = await session.run(project(), { installIn: 'browser', checks: followUp ? task.followUp!.checks : task.checks, outDir });
    const page = await session.run(project(), { installIn: 'browser', checks: await pageChecks(job.task, followUp), outDir });
    rows.push({ cell: job.cell, step: job.step, host: { status: host.status, checks: functional(host) }, page: { status: page.status, checks: functional(page) } });
    console.log(`${job.stack.padEnd(10)} ${job.task.padEnd(15)} ${job.step.padEnd(10)} host ${host.status.padEnd(7)} page ${page.status}`);
    await writeFile(values.out, JSON.stringify(rows, null, 1));
  }
}
try {
  await Promise.all(Array.from({ length: Number(values.parallel) }, worker));
} finally {
  await session.close();
}

let checks = 0;
const differ: string[] = [];
for (const row of rows) {
  for (const [name, host] of Object.entries(row.host.checks)) {
    checks++;
    const page = row.page.checks[name];
    if (page?.status !== host.status) differ.push(`${row.cell} ${row.step} "${name}": host ${host.status}, page ${page?.status ?? 'missing'}\n  host: ${host.message ?? ''}\n  page: ${page?.message ?? ''}`);
  }
}
console.log(`\n${rows.length} steps, ${checks} checks: ${checks - differ.length} agree, ${differ.length} differ`);
for (const d of differ) console.log(d);
