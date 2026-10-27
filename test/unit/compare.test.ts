/** compare() pairs a batch in the browser with one in the reference (src/compare/compare.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare } from '../../src/compare/compare.ts';
import type { NodeRuntime, RunOptions, Session } from '../../src/orchestrator/session.ts';
import type { FailureClass, RunResult } from '../../src/types.ts';
import { tempDir } from './temp-dir.ts';

type Outcome = 'passed' | 'failed' | [FailureClass, string];

/** A session whose runs end as `outcomes[project]` gives them: [browser, reference]. */
function fakeSession(outcomes: Record<string, [Outcome, Outcome]>): Session {
  return {
    async run(project: string, options: RunOptions) {
      const o = outcomes[project][options.nodeRuntime ? 1 : 0];
      const failure = o === 'passed' ? null : o === 'failed' ? { class: 'app-bug', rule: 'blocking-check-failed', message: 'x' } : { class: o[0], rule: o[1], message: o[1] };
      return {
        runId: `r-${project}`,
        status: o === 'passed' ? 'passed' : o === 'failed' ? 'failed' : 'error',
        failure,
        checks: [],
        project: { name: project, path: project, framework: 'vite', snapshotId: project },
        runtime: { name: options.nodeRuntime ? 'docker' : 'node', version: '1' },
        network: { cacheHits: 0, cacheMisses: 0, blocked: [] },
        timings: { totalMs: 1 },
      } as unknown as RunResult;
    },
    browserSandbox: true,
  } as unknown as Session;
}

test("a pair whose project or checks file did not load on either side is excluded, not an agreement", async () => {
  const session = fakeSession({
    ok: ['passed', 'passed'],
    bug: ['failed', 'failed'],
    'bad-checks': [['unknown', 'checks-load'], ['unknown', 'checks-load']],
    'bad-zip': [['app-bug', 'project-load'], ['app-bug', 'project-load']],
    'ref-missing': ['passed', ['unknown', 'project-load']],
    'ref-infra': ['passed', ['infra', 'infra-error']],
  });
  const items = Object.keys({ ok: 0, bug: 0, 'bad-checks': 0, 'bad-zip': 0, 'ref-missing': 0, 'ref-infra': 0 }).map((p) => ({ project: p, label: p }));
  const report = await compare(session, items, { reference: { name: 'docker', factory: () => ({}) as NodeRuntime }, prewarm: false, batchDir: tempDir('sandburg-compare-'), vcpus: 1 });
  assert.deepEqual(report.pairs.filter((p) => p.comparable).map((p) => p.label), ['ok', 'bug']);
  assert.deepEqual([report.overall.n, report.overall.agreement], [2, 1]);
  assert.deepEqual(report.excluded, [
    { label: 'bad-checks', reason: 'checks-load: checks-load' },
    { label: 'bad-zip', reason: 'project-load: project-load' },
    { label: 'ref-missing', reason: 'project-load: project-load' },
    { label: 'ref-infra', reason: 'infra-error' },
  ]);
});
