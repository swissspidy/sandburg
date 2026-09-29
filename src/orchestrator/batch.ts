/**
 * Batch runs: many projects, N tabs at a time, one browser, one cache.
 */
import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
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
  /** Sum of per-run durations divided by wall time: effective parallel speed-up. */
  speedup: number;
  runs: BatchRunSummary[];
}

export interface BatchOptions extends RunOptions {
  parallel?: number;
  /** Batch summary goes to <batchDir>/<batchId>/summary.json. Default: .sandburg/batches */
  batchDir?: string;
  onResult?: (result: RunResult, item: BatchItem, index: number) => void;
}

/** Each subdirectory (or .json file, unless it starts with "." or "_") of `dir` is a project; `checks.spec.ts` inside a project is its checks file. */
export async function discoverProjects(dir: string): Promise<BatchItem[]> {
  const root = resolve(dir);
  const items: BatchItem[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const checks = join(full, 'checks.spec.ts');
      items.push({ project: full, checks: (await exists(checks)) ? checks : undefined, label: entry.name });
    } else if (entry.isFile() && entry.name.endsWith('.json') && !/^[._]/.test(entry.name)) {
      items.push({ project: full, label: entry.name });
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
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      const result = await session.run(item.project, {
        ...options,
        runtime: item.runtime ?? options.runtime,
        checks: item.checks ?? options.checks,
      });
      results[index] = result;
      options.onResult?.(result, item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));

  const wallMs = Math.round(performance.now() - t0);
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
    speedup: wallMs ? Math.round((sum(results.map((r) => r.timings.totalMs)) / wallMs) * 100) / 100 : 0,
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

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
