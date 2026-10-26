/** A seed run reports to the run that started it (Session.runSeed, RunOptions.onSeed). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type RunOptions, type RunRenderer } from '../../src/orchestrator/session.ts';
import type { Project } from '../../src/types.ts';

test("a seed run's phases and renderer go to the callbacks onSeed returns, and ended follows it", async () => {
  const session = new Session();
  const renderer: RunRenderer = { used: () => 1, collectGarbage: async () => {} };
  const internals = session as unknown as {
    runOnce(project: Project, options: RunOptions): Promise<unknown>;
    runSeed(project: Project, checks: object, parent: RunOptions): Promise<void>;
  };
  internals.runOnce = async (_project, options) => {
    assert.equal(options.seed, true);
    options.onPhase?.('start');
    options.onRenderer?.(renderer);
    options.onPhase?.('checks');
    return { status: 'passed', failure: null };
  };
  const seen: string[] = [];
  const parent: RunOptions = {
    onSeed: () => ({
      onPhase: (phase) => seen.push(`phase ${phase}`),
      onRenderer: (r) => seen.push(`renderer ${r === renderer}`),
      ended: () => seen.push('ended'),
    }),
  };
  await internals.runSeed({ name: 'seed' } as Project, {}, parent);
  assert.deepEqual(seen, ['phase start', 'renderer true', 'phase checks', 'ended']);
  // A seed run that fails still ends.
  seen.length = 0;
  internals.runOnce = async () => ({ status: 'error', failure: { message: 'no' } });
  await assert.rejects(internals.runSeed({ name: 'seed' } as Project, {}, parent), /did not pass/);
  assert.deepEqual(seen, ['ended']);
});
