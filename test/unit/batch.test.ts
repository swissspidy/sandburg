import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** A session whose runs report `times[project]` (ms in their checks, and before) and record the order they start in. */
function timedSession(times: Record<string, { checks: number; active?: number }>, started: string[], onOpen?: (open: number) => void) {
  let open = 0;
  return {
    async run(project: string, options: RunOptions) {
      started.push(project);
      onOpen?.(++open);
      options.onPhase?.('checks');
      await sleep(1);
      open--;
      const { checks = 1, active = 1 } = times[project] ?? {};
      return {
        runId: `r-${project}`,
        status: 'passed',
        failure: null,
        project: { name: project, path: resolve(project), snapshotId: project },
        runtime: { name: 'node' },
        network: { cacheHits: 0, cacheMisses: 0, blocked: [] },
        timings: { totalMs: active + checks, checksMs: checks },
      } as unknown as RunResult;
    },
  } as unknown as Session;
}

test('a batch starts the projects whose checks took longest in earlier batches first, new ones before them, then the longest runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    // b and c wait in failing assertions; d and e pass (checks under LONG_CHECKS_MS), d runs longer.
    const times = { a: { checks: 5_000 }, b: { checks: 30_000 }, c: { checks: 15_000 }, d: { checks: 900, active: 9_000 }, e: { checks: 1_200, active: 2_000 } };
    const items = (names: string[]) => names.map((p) => ({ project: p }));
    const first: string[] = [];
    await runBatch(timedSession(times, first), items(['e', 'a', 'b', 'c', 'd']), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(first, ['e', 'a', 'b', 'c', 'd'], 'no history: the order given');

    const second: string[] = [];
    const { results } = await runBatch(timedSession(times, second), items(['e', 'a', 'new', 'b', 'c', 'd']), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(second, ['new', 'b', 'c', 'a', 'd', 'e']);
    assert.deepEqual(results.map((r) => r.project.name), ['e', 'a', 'new', 'b', 'c', 'd'], 'results in the order given');

    const kept: string[] = [];
    await runBatch(timedSession(times, kept), items(['e', 'a', 'b', 'c', 'd']), { parallel: 1, prewarm: false, batchDir: dir, longestFirst: false });
    assert.deepEqual(kept, ['e', 'a', 'b', 'c', 'd']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a batch short of memory opens the next app only when one has ended, and never waits with none open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    const started: string[] = [];
    let maxOpen = 0;
    const lines: string[] = [];
    const { summary } = await runBatch(
      timedSession({}, started, (open) => (maxOpen = Math.max(maxOpen, open))),
      ['a', 'b', 'c', 'd'].map((p) => ({ project: p })),
      // Never enough memory: one app at a time, though four could open.
      { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 0, log: (l) => lines.push(l) },
    );
    assert.equal(summary.totals.passed, 4);
    assert.equal(maxOpen, 1);
    assert.equal(lines.filter((l) => l.startsWith('waiting for memory')).length, 1);

    maxOpen = 0;
    await runBatch(
      timedSession({}, [], (open) => (maxOpen = Math.max(maxOpen, open))),
      ['a', 'b', 'c', 'd'].map((p) => ({ project: p })),
      { parallel: 4, prewarm: false, batchDir: dir, availableMemory: () => 64 * 2 ** 30 },
    );
    assert.equal(maxOpen, 4, 'enough memory: as many as parallel allows');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apps that just opened count against the memory reserve before their memory shows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    let open = 0;
    let maxOpen = 0;
    let shown = 0;
    const session = {
      async run(project: string, options: RunOptions) {
        maxOpen = Math.max(maxOpen, ++open);
        // Starting: its memory does not show in availableMemory yet; in its checks it does (1 GiB).
        await sleep(50);
        shown++;
        options.onPhase?.('checks');
        await sleep(10);
        shown--;
        open--;
        return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 60, checksMs: 10 } } as unknown as RunResult;
      },
    } as unknown as Session;
    // 3 GiB: one app (1 GiB) leaves the 1.5 GiB reserve, two do not.
    const { summary } = await runBatch(session, ['a', 'b', 'c', 'd'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => (3 - shown) * 2 ** 30 });
    assert.equal(summary.totals.passed, 4);
    assert.equal(maxOpen, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an app's memory that shows counts once: the reserve keeps only what it has yet to allocate", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    let open = 0;
    let maxOpen = 0;
    let shown = 0;
    const session = {
      async run(project: string, options: RunOptions) {
        maxOpen = Math.max(maxOpen, ++open);
        // Its renderer already holds 0.9 GiB of the 1 GiB an app without history is expected to reach.
        shown += 0.9;
        options.onRendererMemory?.(() => 0.9 * 2 ** 30);
        await sleep(50);
        options.onPhase?.('checks');
        await sleep(10);
        shown -= 0.9;
        open--;
        return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 60, checksMs: 10 } } as unknown as RunResult;
      },
    } as unknown as Session;
    // 4 GiB: three apps leave 4 - 2.7 - 0.3 = 1 GiB, under the reserve; two leave 2 GiB. Counted as
    // 1 GiB each on top of what shows (ADR 0039), only one more would have opened.
    const { summary } = await runBatch(session, ['a', 'b', 'c', 'd'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => (4 - shown) * 2 ** 30 });
    assert.equal(summary.totals.passed, 4);
    assert.equal(maxOpen, 3);
    assert.ok(summary.runs.every((r) => r.rendererPeakBytes === null));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a project is expected to reach the peak its earlier run measured, in its checks too; a tampered peak is capped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    await mkdir(join(dir, 'b-zzzzzzzz-000000'), { recursive: true });
    const GiB = 2 ** 30;
    const runs = [
      { project: resolve('big'), runtime: 'node', totalMs: 10, checksMs: 1, rendererPeakBytes: 2 * GiB },
      { project: resolve('small'), runtime: 'node', totalMs: 10, checksMs: 1, rendererPeakBytes: 0.2 * GiB },
      { project: resolve('small2'), runtime: 'node', totalMs: 10, checksMs: 1, rendererPeakBytes: 'a lot' },
      { project: resolve('huge'), runtime: 'node', totalMs: 10, checksMs: 1, rendererPeakBytes: 1e30 },
    ];
    await writeFile(join(dir, 'b-zzzzzzzz-000000', 'summary.json'), JSON.stringify({ runs }));
    const session = (log: string[]) => {
      const open = new Set<string>();
      return {
        async run(project: string, options: RunOptions) {
          open.add(project);
          log.push([...open].sort().join('+'));
          options.onRendererMemory?.(() => 0);
          options.onPhase?.('checks');
          await sleep(30);
          open.delete(project);
          return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 30, checksMs: 30 } } as unknown as RunResult;
        },
      } as unknown as Session;
    };
    // 3.5 GiB: "big" (2.2 GiB expected) leaves less than the 1.5 GiB reserve, in its checks too; the
    // small ones (0.22 GiB, and nothing in their checks for one without a valid peak) open together.
    const log: string[] = [];
    await runBatch(session(log), ['big', 'small', 'small2'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 3.5 * GiB });
    assert.deepEqual(log, ['big', 'small', 'small+small2']);
    // A peak beyond reason (4 GiB at most) holds back no more than a 4.4 GiB app would.
    const huge: string[] = [];
    await runBatch(session(huge), ['huge', 'small'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 6 * GiB });
    assert.deepEqual(huge, ['huge', 'huge+small']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch in the browser does not order its starts by an out-of-browser runtime's runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    // compare's reference batch (the Docker runtime) found "a" slow.
    await mkdir(join(dir, 'b-zzzzzzzz-000000'), { recursive: true });
    const runs = [{ project: resolve('a'), runtime: 'docker', totalMs: 60_000, checksMs: 50_000 }];
    await writeFile(join(dir, 'b-zzzzzzzz-000000', 'summary.json'), JSON.stringify({ runs }));
    const started: string[] = [];
    const times = { a: { checks: 1 }, b: { checks: 20_000 } };
    await runBatch(timedSession(times, started), ['a', 'b'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(started, ['a', 'b'], 'no browser history: the order given');
    const again: string[] = [];
    await runBatch(timedSession(times, again), ['a', 'b'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(again, ['b', 'a']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a batch orders its starts by the time earlier runs spent in their checks before their whole time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    await mkdir(join(dir, 'b-zzzzzzzz-000000'), { recursive: true });
    const runs = [
      { project: resolve('heavy'), runtime: 'node', totalMs: 60_000, checksMs: 1_000 },
      { project: resolve('waits'), runtime: 'node', totalMs: 20_000, checksMs: 15_000 },
      { project: resolve('light'), runtime: 'node', totalMs: 5_000, checksMs: 1_000 },
    ];
    await writeFile(join(dir, 'b-zzzzzzzz-000000', 'summary.json'), JSON.stringify({ runs }));
    const started: string[] = [];
    await runBatch(timedSession({}, started), ['light', 'heavy', 'waits'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(started, ['waits', 'heavy', 'light']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
