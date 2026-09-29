/**
 * Fidelity comparison (ADR 0004): run the same projects in an in-browser
 * runtime and in a reference runtime, pair the results, and report agreement.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBatch, type BatchItem, type BatchSummary } from '../orchestrator/batch.ts';
import type { NodeRuntime, RunOptions, Session } from '../orchestrator/session.ts';
import type { RunResult } from '../types.ts';

export interface CompareOptions extends RunOptions {
  /** In-browser runtime under test (default: almostnode). */
  runtime?: string;
  reference: { name: string; factory: () => NodeRuntime };
  parallel?: number;
  referenceParallel?: number;
  /** Batch summaries go to <batchDir>/<batchId>/ (default: .sandburg/batches). */
  batchDir?: string;
  /** Price of one vCPU-hour, for the cost estimate. Default 0.0504 USD (E2B's list price, $0.000014/vCPU-s). */
  vcpuHourUsd?: number;
  /** vCPUs of the machine running the comparison (default: os.availableParallelism()). */
  vcpus?: number;
  referenceTimeouts?: RunOptions['timeouts'];
  onResult?: (side: 'browser' | 'reference', result: RunResult, item: BatchItem) => void;
}

export interface SideOutcome {
  runId: string;
  status: RunResult['status'];
  passed: boolean;
  failureClass: string | null;
  rule: string | null;
  failedChecks: string[];
  totalMs: number;
  message: string | null;
}

export interface ComparePair {
  label: string;
  framework: string;
  /** Corpus metadata (meta.json), when the project has one. */
  meta: Record<string, unknown> | null;
  browser: SideOutcome;
  reference: SideOutcome;
  /** False when the reference could not judge the app (infra error). */
  comparable: boolean;
  agree: boolean;
  /** "browser-stricter": browser failed, reference passed. "browser-lenient": the reverse. */
  disagreement: 'browser-stricter' | 'browser-lenient' | null;
  cause: string | null;
}

export interface Rates {
  n: number;
  agreement: number;
  bothPass: number;
  bothFail: number;
  browserStricter: number;
  browserLenient: number;
}

export interface TimingStats {
  medianMs: number;
  p90Ms: number;
  meanMs: number;
  wallMs: number;
  parallel: number;
  /** Wall time of the batch divided by runs: machine time per run at this parallelism. */
  machineMsPerRun: number;
  costUsdPerRun: number;
}

export interface CompareReport {
  schemaVersion: 1;
  createdAt: string;
  runtime: string;
  reference: string;
  vcpus: number;
  vcpuHourUsd: number;
  overall: Rates;
  byFramework: Record<string, Rates>;
  /** Disagreement causes (classifier rule or seeded fault) → count. */
  causes: Record<string, number>;
  /** Against corpus ground truth (meta.expected), when present. */
  groundTruth: { n: number; browserAccuracy: number; referenceAccuracy: number } | null;
  excluded: { label: string; reason: string }[];
  timing: { browser: TimingStats; reference: TimingStats };
  batches: { browser: string; reference: string };
  pairs: ComparePair[];
}

export async function compare(session: Session, items: BatchItem[], options: CompareOptions): Promise<CompareReport> {
  const vcpus = options.vcpus ?? (await import('node:os')).availableParallelism();
  const vcpuHourUsd = options.vcpuHourUsd ?? 0.0504;
  const browserRun = await runBatch(session, items, {
    ...options,
    parallel: options.parallel ?? 4,
    onResult: (r, item) => options.onResult?.('browser', r, item),
  });
  const referenceRun = await runBatch(session, items, {
    ...options,
    nodeRuntime: options.reference.factory,
    parallel: options.referenceParallel ?? 3,
    timeouts: { install: 600_000, start: 180_000, ready: 180_000, ...options.referenceTimeouts },
    onResult: (r, item) => options.onResult?.('reference', r, item),
  });

  const pairs: ComparePair[] = [];
  for (let i = 0; i < items.length; i++) {
    const b = browserRun.results[i];
    const ref = referenceRun.results[i];
    const meta = await readMeta(items[i]);
    const browser = outcome(b);
    const reference = outcome(ref);
    const comparable = ref.failure?.class !== 'infra';
    const agree = browser.passed === reference.passed;
    const disagreement = !comparable || agree ? null : browser.passed ? 'browser-lenient' : 'browser-stricter';
    let cause: string | null = null;
    if (disagreement === 'browser-stricter') cause = browser.rule ?? 'unclassified';
    if (disagreement === 'browser-lenient') cause = meta?.fault && meta.fault !== 'none' ? `lenient:${String(meta.fault)}` : `lenient:${reference.rule ?? 'unclassified'}`;
    pairs.push({
      label: items[i].label ?? b.project.name,
      framework: String(meta?.framework ?? b.project.framework),
      meta,
      browser,
      reference,
      comparable,
      agree,
      disagreement,
      cause,
    });
  }

  const comparable = pairs.filter((p) => p.comparable);
  const byFramework: Record<string, Rates> = {};
  for (const fw of [...new Set(comparable.map((p) => p.framework))].sort()) byFramework[fw] = rates(comparable.filter((p) => p.framework === fw));
  const causes: Record<string, number> = {};
  for (const p of comparable) if (p.cause) causes[p.cause] = (causes[p.cause] ?? 0) + 1;
  const truth = comparable.filter((p) => p.meta?.expected === 'pass' || p.meta?.expected === 'fail');

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runtime: `${browserRun.results[0]?.runtime.name} ${browserRun.results[0]?.runtime.version}`,
    reference: `${referenceRun.results[0]?.runtime.name} ${referenceRun.results[0]?.runtime.version}`,
    vcpus,
    vcpuHourUsd,
    overall: rates(comparable),
    byFramework,
    causes: Object.fromEntries(Object.entries(causes).sort((a, b) => b[1] - a[1])),
    groundTruth: truth.length
      ? {
          n: truth.length,
          browserAccuracy: ratio(truth.filter((p) => p.browser.passed === (p.meta!.expected === 'pass')).length, truth.length),
          referenceAccuracy: ratio(truth.filter((p) => p.reference.passed === (p.meta!.expected === 'pass')).length, truth.length),
        }
      : null,
    excluded: pairs.filter((p) => !p.comparable).map((p) => ({ label: p.label, reason: p.reference.message ?? 'reference infra error' })),
    timing: {
      browser: timing(browserRun.summary, browserRun.results, vcpus, vcpuHourUsd),
      reference: timing(referenceRun.summary, referenceRun.results, vcpus, vcpuHourUsd),
    },
    batches: { browser: browserRun.summary.batchId, reference: referenceRun.summary.batchId },
    pairs,
  };
}

function outcome(r: RunResult): SideOutcome {
  return {
    runId: r.runId,
    status: r.status,
    passed: r.status === 'passed',
    failureClass: r.failure?.class ?? null,
    rule: r.failure?.rule ?? null,
    failedChecks: r.checks.filter((c) => c.blocking && c.status !== 'passed').map((c) => c.name),
    totalMs: r.timings.totalMs,
    message: r.failure?.message.split('\n')[0].slice(0, 300) ?? null,
  };
}

function rates(pairs: ComparePair[]): Rates {
  return {
    n: pairs.length,
    agreement: ratio(pairs.filter((p) => p.agree).length, pairs.length),
    bothPass: pairs.filter((p) => p.agree && p.browser.passed).length,
    bothFail: pairs.filter((p) => p.agree && !p.browser.passed).length,
    browserStricter: pairs.filter((p) => p.disagreement === 'browser-stricter').length,
    browserLenient: pairs.filter((p) => p.disagreement === 'browser-lenient').length,
  };
}

function timing(summary: BatchSummary, results: RunResult[], vcpus: number, vcpuHourUsd: number): TimingStats {
  const xs = results.map((r) => r.timings.totalMs).sort((a, b) => a - b);
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
  const machineMsPerRun = results.length ? summary.wallMs / results.length : 0;
  return {
    medianMs: q(0.5),
    p90Ms: q(0.9),
    meanMs: Math.round(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)),
    wallMs: summary.wallMs,
    parallel: summary.parallel,
    machineMsPerRun: Math.round(machineMsPerRun),
    costUsdPerRun: (machineMsPerRun / 1000 / 3600) * vcpus * vcpuHourUsd,
  };
}

function ratio(a: number, b: number): number {
  return b ? Math.round((a / b) * 1000) / 1000 : 0;
}

async function readMeta(item: BatchItem): Promise<Record<string, unknown> | null> {
  if (typeof item.project !== 'string' || item.project.startsWith('snapshot:')) return null;
  try {
    return JSON.parse(await readFile(join(item.project, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}
