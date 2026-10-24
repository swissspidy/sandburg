/**
 * Batch runs: many projects, N tabs at a time, one browser, one cache.
 */
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FailureClass, Project, RunResult } from '../types.ts';
import type { RunOptions, Session } from './session.ts';

export interface BatchItem {
  /** Directory, JSON file tree, "snapshot:<id>", or an in-memory project. */
  project: string | Project;
  /** Per-project checks (path or object); falls back to the batch's checks. */
  checks?: RunOptions['checks'];
  runtime?: string;
  /** Free-form label carried into the summary (e.g. corpus metadata). */
  label?: string;
}

export interface BatchRunSummary {
  label?: string;
  project: string;
  runId: string;
  snapshotId: string;
  runtime: string;
  status: RunResult['status'];
  failureClass: FailureClass | null;
  failureRule: string | null;
  totalMs: number;
}

export interface BatchSummary {
  schemaVersion: 1;
  batchId: string;
  parallel: number;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  totals: {
    runs: number;
    passed: number;
    failed: number;
    error: number;
    byClass: Partial<Record<FailureClass, number>>;
    cacheHits: number;
    cacheMisses: number;
    blockedRequests: number;
  };
  /** Sum of per-run durations divided by the time the runs took (after any warm-up): effective parallel speed-up. */
  speedup: number;
  runs: BatchRunSummary[];
}

export interface BatchOptions extends RunOptions {
  parallel?: number;
  /** Batch summary goes to <batchDir>/<batchId>/summary.json. Default: .sandburg/batches */
  batchDir?: string;
  onResult?: (result: RunResult, item: BatchItem, index: number) => void;
  /** Warm up common stacks first when their installs are missing (Session.prewarm). Default: true. */
  prewarm?: boolean;
  /** Progress lines (warming up). */
  log?: (line: string) => void;
  /**
   * Start the projects that took longest in earlier batches first (the summaries in batchDir), and
   * those without an earlier run before them (default: true). False: in the order given. Results
   * are in the order given either way.
   */
  longestFirst?: boolean;
}

/** Each subdirectory, .zip, or .json file (unless its name starts with "." or "_") of `dir` is a project; `checks.spec.ts` inside a project directory, or `<name>.checks.spec.ts` next to an archive, is its checks file. */
export async function discoverProjects(dir: string): Promise<BatchItem[]> {
  const root = resolve(dir);
  const items: BatchItem[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const checks = join(full, 'checks.spec.ts');
      items.push({ project: full, checks: (await exists(checks)) ? checks : undefined, label: entry.name });
    } else if (entry.isFile() && /\.(json|zip)$/.test(entry.name) && !/^[._]/.test(entry.name)) {
      // An archive's checks sit next to it: app.zip → app.checks.spec.ts.
      const checks = full.replace(/\.(json|zip)$/, '.checks.spec.ts');
      items.push({ project: full, checks: (await exists(checks)) ? checks : undefined, label: entry.name });
    }
  }
  return items;
}

export async function runBatch(session: Session, items: BatchItem[], options: BatchOptions = {}): Promise<{ summary: BatchSummary; results: RunResult[] }> {
  const parallel = Math.max(1, options.parallel ?? 4);
  const batchId = `b-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const startedAt = new Date();
  const t0 = performance.now();
  const results: RunResult[] = new Array(items.length);
  const order = options.longestFirst === false ? items.map((_, i) => i) : await longestFirst(items, options.batchDir ?? '.sandburg/batches');
  let next = 0;
  // The first apps of a stack would otherwise each install and seed it, several tabs at once.
  if (options.prewarm !== false && !options.nodeRuntime) await session.prewarm({ runtime: options.runtime, log: options.log });
  // The speed-up compares the runs with the time they took, not with the one-time warm-up before them.
  const runsStarted = performance.now();

  // `parallel` apps start and run at a time; an app in its checks (light work, often waiting on a
  // failing assertion) no longer counts, and the next app starts. At most twice `parallel` are open.
  let starting = 0;
  let open = 0;
  const wake: (() => void)[] = [];
  const free = () => wake.splice(0).forEach((w) => w());
  const runs: Promise<void>[] = [];
  while (next < items.length) {
    while (starting >= parallel || open >= 2 * parallel) await new Promise<void>((r) => wake.push(r));
    const index = order[next++];
    const item = items[index];
    starting++;
    open++;
    let counted = true;
    const done = () => {
      if (counted) starting--;
      counted = false;
      free();
    };
    const run = session
      .run(item.project, {
        ...options,
        runtime: item.runtime ?? options.runtime,
        checks: item.checks ?? options.checks,
        onPhase: (phase) => {
          options.onPhase?.(phase);
          if (phase === 'checks') done();
        },
      })
      .then((result) => {
        results[index] = result;
        options.onResult?.(result, item, index);
      })
      .finally(() => {
        open--;
        done();
      });
    // Handled now, while the loop may wait for a slot: Promise.all(runs) below rejects with it.
    run.catch(() => {});
    runs.push(run);
  }
  await Promise.all(runs);

  const wallMs = Math.round(performance.now() - t0);
  const runsMs = Math.round(performance.now() - runsStarted);
  const byClass: BatchSummary['totals']['byClass'] = {};
  for (const r of results) if (r.failure) byClass[r.failure.class] = (byClass[r.failure.class] ?? 0) + 1;
  const summary: BatchSummary = {
    schemaVersion: 1,
    batchId,
    parallel,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    wallMs,
    totals: {
      runs: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      error: results.filter((r) => r.status === 'error').length,
      byClass,
      cacheHits: sum(results.map((r) => r.network.cacheHits)),
      cacheMisses: sum(results.map((r) => r.network.cacheMisses)),
      blockedRequests: sum(results.map((r) => r.network.blocked.length)),
    },
    speedup: runsMs ? Math.round((sum(results.map((r) => r.timings.totalMs)) / runsMs) * 100) / 100 : 0,
    runs: results.map((r, i) => ({
      label: items[i].label,
      project: r.project.path,
      runId: r.runId,
      snapshotId: r.project.snapshotId,
      runtime: r.runtime.name,
      status: r.status,
      failureClass: r.failure?.class ?? null,
      failureRule: r.failure?.rule ?? null,
      totalMs: r.timings.totalMs,
    })),
  };
  const dir = resolve(options.batchDir ?? '.sandburg/batches', batchId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { summary, results };
}

/**
 * The items' indexes, those whose project took longest in the latest batches first, and those with no
 * earlier run (a new project, which may install first) before all of them; otherwise in the order
 * given. A batch's wall time is its last app's end: an app that waits long in its checks (a failing
 * assertion) or runs long, started last, keeps the batch open with the cores idle. Started first, it
 * overlaps the others. Only the order changes, never what a run does.
 */
async function longestFirst(items: BatchItem[], batchDir: string, batches = HISTORY_BATCHES): Promise<number[]> {
  const took = new Map<string, number>();
  const dir = resolve(batchDir);
  // Batch ids start with their start time in base 36: the newest first.
  const ids = (await readdir(dir).catch(() => [] as string[])).filter((id) => /^b-[0-9a-z]+-[0-9a-f]+$/.test(id));
  ids.sort((a, b) => parseInt(b.split('-')[1], 36) - parseInt(a.split('-')[1], 36));
  for (const id of ids.slice(0, batches)) {
    const summary = await readFile(join(dir, id, 'summary.json'), 'utf8').then(
      (t) => JSON.parse(t) as Partial<BatchSummary>,
      () => null,
    );
    for (const run of Array.isArray(summary?.runs) ? summary.runs : []) {
      if (typeof run?.project === 'string' && Number.isFinite(run.totalMs) && !took.has(run.project)) took.set(run.project, run.totalMs);
    }
  }
  const estimate = items.map((item) => (typeof item.project === 'string' ? took.get(resolve(item.project)) : undefined) ?? Infinity);
  return items.map((_, i) => i).sort((a, b) => estimate[b] - estimate[a] || a - b);
}
/** How many of the latest batch summaries longestFirst reads. */
const HISTORY_BATCHES = 20;

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
