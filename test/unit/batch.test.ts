import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
