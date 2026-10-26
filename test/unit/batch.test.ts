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
  // App "slow" stays in its checks until the five others have ended (or 5 s): the order shows whether
  // they ran meanwhile, however long their timers take on a loaded machine.
  let othersEnded!: () => void;
  const others = new Promise<void>((r) => (othersEnded = r));
  const fallback = setTimeout(othersEnded, 5000);
  void others.then(() => clearTimeout(fallback));
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
      await (project === 'slow' ? others : sleep(20));
      open--;
      order.push(`end ${project}`);
      if (order.filter((o) => o.startsWith('end ') && o !== 'end slow').length === 5) othersEnded();
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
      const { checks, active = 1 } = times[project] ?? { checks: 1 };
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

test('a batch whose earlier summaries are cut off or not batch summaries still runs, in the order given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    // A batch ended while it wrote its summary (writeFile is not atomic), and one that is valid JSON of another shape.
    for (const [id, text] of [['b-zz-00', '{"runs": [{"project": "a", "checks'], ['b-zy-00', '"runs"'], ['b-zx-00', 'null']]) {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(join(dir, id, 'summary.json'), text);
    }
    const started: string[] = [];
    await runBatch(timedSession({}, started), ['a', 'b'].map((p) => ({ project: p })), { parallel: 1, prewarm: false, batchDir: dir });
    assert.deepEqual(started, ['a', 'b']);
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
        options.onRenderer?.({ used: () => 0.9 * 2 ** 30, collectGarbage: async () => {} });
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

test('a project is expected to reach the peak its earlier run measured until its checks; a tampered peak is capped', async () => {
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
    const session = (log: string[]) =>
      ({
        async run(project: string, options: RunOptions) {
          log.push(`start ${project}`);
          // By its checks, its renderer has reached its earlier peak (2 GiB for "big").
          let used = 0;
          options.onRenderer?.({ used: () => used, peak: () => used, collectGarbage: async () => {} });
          await sleep(40);
          used = project === 'big' ? 2 * GiB : 0;
          log.push(`checks ${project}`);
          options.onPhase?.('checks');
          await sleep(40);
          return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 80, checksMs: 40 } } as unknown as RunResult;
        },
      }) as unknown as Session;
    // 3.5 GiB: "big" (2.2 GiB expected) leaves less than the 1.5 GiB reserve until its checks; the
    // small ones (0.22 GiB, and 1 GiB for one without a valid peak) open together then.
    const log: string[] = [];
    await runBatch(session(log), ['big', 'small', 'small2'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 3.5 * GiB });
    assert.deepEqual(log.slice(0, 4), ['start big', 'checks big', 'start small', 'start small2']);
    // A peak beyond reason counts as 4.4 GiB at most: 6 GiB leave the reserve for the next app.
    const huge: string[] = [];
    await runBatch(session(huge), ['huge', 'small'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 6 * GiB });
    assert.deepEqual(huge.slice(0, 3), ['start huge', 'start small', 'checks huge']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an app that allocates past its expected peak before its checks is expected to go on growing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    const GiB = 2 ** 30;
    let shown = 0;
    const log: string[] = [];
    let maxShown = 0;
    const session = {
      async run(project: string, options: RunOptions) {
        log.push(`start ${project}`);
        // A late allocator with no earlier run: past the 1 GiB expected of it (1.4 GiB), then on to
        // 2 GiB before its checks. The others hold 0.5 GiB.
        let used = 0;
        const grow = (to: number) => {
          shown += to - used;
          used = to;
          maxShown = Math.max(maxShown, shown);
        };
        options.onRenderer?.({ used: () => used * GiB, peak: () => used * GiB, collectGarbage: async () => {} });
        grow(project === 'late' ? 1.4 : 0.5);
        await sleep(100);
        if (project === 'late') grow(2);
        await sleep(20);
        options.onPhase?.('checks');
        log.push(`checks ${project}`);
        grow(0);
        return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 120, checksMs: 1 } } as unknown as RunResult;
      },
    } as unknown as Session;
    // 3.5 GiB: at 1.4 GiB, "late" leaves 2.1 GiB, which a guard that counts it as done growing takes
    // for "b"; then "late" grows on, to 2.5 GiB of the 3.5 in use. Expected to reach 1.5 x 1.4 =
    // 2.1 GiB, it leaves 1.4 GiB, under the 1.5 GiB reserve: "b" waits for its checks.
    const memory = () => 3.5 * GiB - shown * GiB;
    await runBatch(session, ['late', 'b'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: memory });
    assert.deepEqual(log.slice(0, 3), ['start late', 'checks late', 'start b']);
    assert.ok(maxShown <= 2, `at most 2 GiB in use at once, not ${maxShown}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an app that allocates in its checks holds what its earlier run reached beyond its own peak', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    const GiB = 2 ** 30;
    // Its earlier run reached 2 GiB: most of it in its checks (a route compiled on first visit).
    await mkdir(join(dir, 'b-zzzzzzzz-000000'), { recursive: true });
    await writeFile(join(dir, 'b-zzzzzzzz-000000', 'summary.json'), JSON.stringify({ runs: [{ project: resolve('late'), runtime: 'node', totalMs: 10, checksMs: 1, rendererPeakBytes: 2 * GiB }] }));
    let shown = 0;
    let maxShown = 0;
    const log: string[] = [];
    const session = {
      async run(project: string, options: RunOptions) {
        log.push(`start ${project}`);
        let used = 0;
        let peak = 0;
        const grow = (to: number) => {
          shown += to - used;
          used = to;
          peak = Math.max(peak, to);
          maxShown = Math.max(maxShown, shown);
        };
        options.onRenderer?.({ used: () => used * GiB, peak: () => peak * GiB, collectGarbage: async () => {} });
        grow(0.5);
        options.onPhase?.('checks');
        if (project === 'late') {
          await sleep(50);
          grow(2);
          await sleep(50);
        }
        log.push(`end ${project}`);
        grow(0);
        return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 100, checksMs: 100 } } as unknown as RunResult;
      },
    } as unknown as Session;
    // 3 GiB: in its checks at 0.5 GiB, "late" leaves 2.5 GiB unless it holds the 1.5 GiB its
    // earlier run reached beyond that; "b" (1 GiB expected, 0.5 used) waits for it to end.
    await runBatch(session, ['late', 'b'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 3 * GiB - shown * GiB });
    assert.deepEqual(log, ['start late', 'end late', 'start b', 'end b']);
    assert.ok(maxShown <= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a seed run an app starts (its own renderer) counts against the memory reserve until it ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    const GiB = 2 ** 30;
    const log: string[] = [];
    const session = {
      async run(project: string, options: RunOptions) {
        log.push(`start ${project}`);
        if (project === 'a') {
          // A cold Next.js install seeds beside the app: the seed's renderer has not allocated yet.
          const seed = options.onSeed!();
          seed.onRenderer?.({ used: () => 0, peak: () => 0, collectGarbage: async () => {} });
          void sleep(100).then(() => {
            log.push('seed ended');
            seed.ended();
          });
        }
        options.onPhase?.('checks');
        log.push(`checks ${project}`);
        await sleep(project === 'a' ? 200 : 10);
        return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 10, checksMs: 10 } } as unknown as RunResult;
      },
    } as unknown as Session;
    // 2.4 GiB: "a" in its checks leaves all of it, but its seed is expected to reach 1 GiB: "b" waits for it.
    await runBatch(session, ['a', 'b'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => 2.4 * GiB });
    assert.deepEqual(log.slice(0, 4), ['start a', 'checks a', 'seed ended', 'start b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a batch short of memory has its apps in their checks collect garbage before it waits, at most every 10 s', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-batch-'));
  try {
    const GiB = 2 ** 30;
    let garbage = 0;
    const collected: string[] = [];
    const log: string[] = [];
    const session = {
      async run(project: string, options: RunOptions) {
        log.push(`start ${project}`);
        // Each app leaves 1 GiB of garbage once it has compiled; a collection frees it.
        let mine = 0;
        options.onRenderer?.({
          used: () => 0,
          collectGarbage: async () => {
            collected.push(project);
            garbage -= mine;
            mine = 0;
          },
        });
        garbage += mine = 1;
        options.onPhase?.('checks');
        await sleep(project === 'a' ? 1000 : 10);
        garbage -= mine;
        log.push(`end ${project}`);
        return { runId: `r-${project}`, status: 'passed', failure: null, project: { name: project, path: resolve(project), snapshotId: project }, runtime: { name: 'node' }, network: { cacheHits: 0, cacheMisses: 0, blocked: [] }, timings: { totalMs: 10, checksMs: 10 } } as unknown as RunResult;
      },
    } as unknown as Session;
    // 2 GiB less the garbage: "a" in its checks leaves 1 GiB, under the reserve, until it collects.
    await runBatch(session, ['a', 'b'].map((p) => ({ project: p })), { parallel: 4, prewarm: false, batchDir: dir, longestFirst: false, availableMemory: () => (2 - garbage) * GiB });
    assert.deepEqual(log, ['start a', 'start b', 'end b', 'end a'], '"b" opened while "a" was in its checks');
    assert.deepEqual(collected, ['a']);
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
