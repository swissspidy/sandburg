import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runBatch, type BatchItem } from '../../src/orchestrator/batch.ts';
import type { RunOptions, Session } from '../../src/orchestrator/session.ts';
import type { RunResult } from '../../src/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a batch starts its next app when one reaches its checks, with at most twice `parallel` open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  let starting = 0;
  let open = 0;
  let maxStarting = 0;
  let maxOpen = 0;
  const order: string[] = [];
  const session = {
    async run(project: string, options: RunOptions) {
      starting++;
      open++;
      maxStarting = Math.max(maxStarting, starting);
      maxOpen = Math.max(maxOpen, open);
      order.push(`start ${project}`);
      options.onPhase?.('start');
      await sleep(20);
      starting--;
      options.onPhase?.('checks');
      // App "slow" waits long in its checks (a failing assertion): the others go on meanwhile.
      await sleep(project === 'slow' ? 200 : 20);
      open--;
      order.push(`end ${project}`);
      return {
        runId: `r-${project}`,
        status: 'passed',
        failure: null,
        project: { name: project, path: project, snapshotId: project },
        runtime: { name: 'node' },
        network: { cacheHits: 0, cacheMisses: 0, blocked: [] },
        timings: { totalMs: 40 },
      } as unknown as RunResult;
    },
  } as unknown as Session;
  try {
    const items: BatchItem[] = ['slow', 'a', 'b', 'c', 'd', 'e'].map((p) => ({ project: p }));
    const { summary, results } = await runBatch(session, items, { parallel: 2, prewarm: false, batchDir: dir });
    assert.deepEqual(results.map((r) => r.project.name), ['slow', 'a', 'b', 'c', 'd', 'e']);
    assert.equal(summary.totals.passed, 6);
    assert.equal(maxStarting, 2);
    assert.ok(maxOpen > 2 && maxOpen <= 4, `open at once: ${maxOpen}`);
    // The others finished while "slow" was in its checks.
    assert.equal(order.at(-1), 'end slow');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run that rejects while the batch waits for a slot rejects the batch (no unhandled rejection)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  const session = {
    async run(project: string) {
      // "fails" fails at once; "long" holds the only slot meanwhile.
      if (project === 'fails') throw new Error('run failed');
      await sleep(100);
      return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: project, snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 1 } } as unknown as RunResult;
    },
  } as unknown as Session;
  try {
    const items: BatchItem[] = ['fails', 'long', 'after'].map((p) => ({ project: p }));
    await assert.rejects(runBatch(session, items, { parallel: 1, prewarm: false, batchDir: dir }), /run failed/);
    await sleep(10);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await rm(dir, { recursive: true, force: true });
  }
});

/** A session whose runs take `ms[project]` and record the order they start in. */
function timedSession(ms: Record<string, number>, started: string[], onOpen?: (open: number) => void) {
  let open = 0;
  return {
    async run(project: string, options: RunOptions) {
      started.push(project);
      onOpen?.(++open);
      options.onPhase?.('checks');
      await sleep(ms[project] ?? 1);
      open--;
      return {
        runId: `r-${project}`,
        status: 'passed',
        failure: null,
        project: { name: project, path: resolve(project), snapshotId: project },
        runtime: { name: 'node' },
        network: { cacheHits: 0, cacheMisses: 0, blocked: [] },
        timings: { totalMs: ms[project] ?? 1 },
      } as unknown as RunResult;
    },
  } as unknown as Session;
}

test('a batch starts the projects that took longest in earlier batches first, new ones before them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    const ms = { a: 5, b: 30, c: 15, d: 1 };
    const first: string[] = [];
    await runBatch(timedSession(ms, first), ['a', 'b', 'c', 'd'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(first, ['a', 'b', 'c', 'd'], 'no history: the order given');

    const second: string[] = [];
    const { results } = await runBatch(timedSession(ms, second), ['a', 'new', 'b', 'c', 'd'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(second, ['new', 'b', 'c', 'a', 'd']);
    assert.deepEqual(results.map((r) => r.project.name), ['a', 'new', 'b', 'c', 'd'], 'results in the order given');

    const kept: string[] = [];
    await runBatch(timedSession(ms, kept), ['a', 'b', 'c', 'd'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir, longestFirst: false });
    assert.deepEqual(kept, ['a', 'b', 'c', 'd']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
