/**
 * Batch runs: many projects, N tabs at a time, one browser, one cache.
 */
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { adapterNames } from '../adapters.ts';
import type { FailureClass, Project, RunResult } from '../types.ts';
import type { RunOptions, Session } from './session.ts';
import { availableMemory } from './memory.ts';

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
  /** The checks phase's time (an app that waits long on a failing assertion). */
  checksMs?: number | null;
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
  /** Apps that start and run at a time (default: defaultParallel()). */
  parallel?: number;
  /** Batch summary goes to <batchDir>/<batchId>/summary.json. Default: .sandburg/batches */
  batchDir?: string;
  onResult?: (result: RunResult, item: BatchItem, index: number) => void;
  /** Warm up common stacks first when their installs are missing (Session.prewarm). Default: true. */
  prewarm?: boolean;
  /** Progress lines (warming up). */
  log?: (line: string) => void;
  /**
   * Start the projects whose checks took longest in earlier batches first, then those that ran
   * longest (the summaries in batchDir), and those without an earlier run before them (default:
   * true; see longestFirst). False: in the order given. Results are in the order given either way.
   */
  longestFirst?: boolean;
  /**
   * Bytes of memory that must be available (availableMemory) to open another app while others are
   * open (default: MEMORY_RESERVE); 0 turns this off. Short of it, the batch waits for an app to end,
   * or for memory to free up, so that a batch with more tabs than the machine can hold does not run
   * into the out-of-memory killer (which takes the browser and every open app with it).
   */
  memoryReserve?: number;
  /** Bytes of memory available (default: availableMemory). For tests. */
  availableMemory?: () => number;
}

/**
 * Apps a batch starts at a time unless told: one per core, up to 8. A run keeps several threads of
 * the renderer busy, so more apps than cores did not finish sooner (24 corpus apps on 4 cores: 41.9 s
 * at 4, 41.4 s at 6; 12 on 2 cores: 39.5-40.9 s at 2, 40.2-42.3 s at 4), and each open app holds
 * its renderer's memory (0.5-1 GB).
 */
export function defaultParallel(): number {
  return Math.max(1, Math.min(8, availableParallelism()));
}

/**
 * The memory a batch keeps free before it opens another app: about one app's peak (a Next.js run's
 * renderer peaks at ~1 GB, a Vite run's at ~0.5 GB) and the host's share of an install.
 */
export const MEMORY_RESERVE = 1.5 * 2 ** 30;

/**
 * What an app that just opened is counted as using, though availableMemory does not show it yet: its
 * renderer and runtimes allocate as it installs and starts. About a Next.js run's renderer peak (the
 * largest), for START_WINDOW_MS after it opened or until it reaches its checks, whichever is first.
 * Without it, a batch opened its first `parallel` apps in one go, before any of them used memory.
 */
export const START_ALLOWANCE = 2 ** 30;
const START_WINDOW_MS = 10_000;

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
  const parallel = Math.max(1, options.parallel ?? defaultParallel());
  const batchId = `b-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const startedAt = new Date();
  const t0 = performance.now();
  const results: RunResult[] = new Array(items.length);
  const order = options.longestFirst === false ? items.map((_, i) => i) : await longestFirst(items, options.batchDir ?? '.sandburg/batches', !!options.nodeRuntime);
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
  const reserve = options.memoryReserve ?? MEMORY_RESERVE;
  const memory = options.availableMemory ?? availableMemory;
  // Apps that opened lately and have not reached their checks: their memory may not show yet.
  const recent = new Set<number>();
  const available = () => {
    const now = performance.now();
    for (const at of recent) if (now - at > START_WINDOW_MS) recent.delete(at);
    return memory() - recent.size * START_ALLOWANCE;
  };
  // With an app open, the next opens only when there is memory for it; with none, it always opens.
  const short = () => reserve > 0 && open > 0 && available() < reserve;
  let waitedForMemory = false;
  while (next < items.length) {
    for (;;) {
      if (starting >= parallel || open >= 2 * parallel) await new Promise<void>((r) => wake.push(r));
      else if (short()) {
        if (!waitedForMemory) options.log?.(`waiting for memory to open the next app (${Math.round(available() / 2 ** 20)} MB available, ${Math.round(reserve / 2 ** 20)} MB needed)`);
        waitedForMemory = true;
        // An app that ends frees its memory, but so may the others as they go on: look again in a while.
        await new Promise<void>((r) => {
          const timer = setTimeout(r, MEMORY_POLL_MS);
          wake.push(() => (clearTimeout(timer), r()));
        });
      } else break;
    }
    const index = order[next++];
    const item = items[index];
    starting++;
    open++;
    let counted = true;
    // Distinct from the others' (a set of times, as two apps may open in the same millisecond).
    let openedAt = performance.now();
    while (recent.has(openedAt)) openedAt += 1e-6;
    recent.add(openedAt);
    const done = () => {
      if (counted) starting--;
      counted = false;
      recent.delete(openedAt);
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
      checksMs: r.timings.checksMs,
    })),
  };
  const dir = resolve(options.batchDir ?? '.sandburg/batches', batchId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { summary, results };
}

/**
 * The items' indexes in the order to start them, from the latest batches' summaries: first those
 * with no checks time there (a new project, which may install first; one that failed before its
 * checks, which waits out a grace period), then those whose checks took LONG_CHECKS_MS or more,
 * longest first, then the others by the time before their checks, longest first; ties in the order
 * given. A batch's wall time is its last app's end: an app that waits in its checks (a failing
 * assertion waits 5-15 s) or runs long, started last, keeps the batch open while the cores have
 * nothing else to run. (Ordering by the whole run's time alone gained as much, but started the
 * heavy apps side by side: 16% more peak memory.) Only the order changes, never what a run does.
 */
async function longestFirst(items: BatchItem[], batchDir: string, outOfBrowser: boolean, batches = HISTORY_BATCHES): Promise<number[]> {
  const took = new Map<string, { checks: number; active: number }>();
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
      // Runs in the browser, or in an out-of-browser runtime (compare's reference), as this batch's.
      if (adapterNames.includes(run?.runtime) === outOfBrowser) continue;
      if (typeof run?.project === 'string' && Number.isFinite(run.checksMs) && Number.isFinite(run.totalMs) && !took.has(run.project))
        took.set(run.project, { checks: run.checksMs!, active: run.totalMs - run.checksMs! });
    }
  }
  const known = items.map((item) => (typeof item.project === 'string' ? took.get(resolve(item.project)) : undefined));
  // Checks shorter than LONG_CHECKS_MS (a passing app's) count as none: then the longest run first.
  const checks = known.map((k) => (k ? (k.checks >= LONG_CHECKS_MS ? k.checks : 0) : Infinity));
  const active = known.map((k) => k?.active ?? 0);
  return items.map((_, i) => i).sort((a, b) => checks[b] - checks[a] || active[b] - active[a] || a - b);
}
/** Checks that take longer wait on a failing assertion (settlingExpect waits 5 s first); a passing app's take 0.5-2 s. */
const LONG_CHECKS_MS = 3000;

/** How often a batch short of memory looks again. */
const MEMORY_POLL_MS = 500;

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
