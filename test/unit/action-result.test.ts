import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResult, summary } from '../../scripts/action-result.ts';
import type { RunResult } from '../../src/types.ts';

// The GitHub Action's last step (action.yml, scripts/action-result.ts).
const result = {
  runId: 'r1',
  status: 'failed',
  project: { name: 'app', framework: 'vite' },
  timings: { totalMs: 1234 },
  failure: { class: 'app-bug', phase: 'checks', rule: 'blocking-check-failed', message: '1 blocking check(s) failed' },
  checks: [{ name: 'a | b', status: 'failed', blocking: true, message: 'expected 1\nreceived 0' }],
} as unknown as RunResult;

test("the action reads sandburg's JSON, also after other output, and summarizes it", () => {
  const json = JSON.stringify(result, null, 2);
  assert.equal(parseResult(json)?.runId, 'r1');
  assert.equal(parseResult(`a line of log\n${json}`)?.status, 'failed');
  assert.equal(parseResult('error: no such project'), null);
  const md = summary(result, 1);
  assert.match(md, /### Sandburg: failed/);
  assert.match(md, /\*\*app-bug\*\* in checks \(`blocking-check-failed`\)/);
  assert.match(md, /\| a \\\| b \| failed: expected 1 \| yes \|/);
  assert.match(summary(null, 2), /exited 2 without a result/);
});
