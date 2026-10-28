import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { anchors, brokenLinks, links, slug } from '../../scripts/doc-links.ts';
import { parseResult, summary } from '../../scripts/action-result.ts';
import type { RunResult } from '../../src/types.ts';

// The security policy is added by its own pull request; until it is on this branch, its link is the one allowed to dangle.
const PENDING = existsSync('SECURITY.md') ? [] : ['docs/guide/security.md: ../../SECURITY.md (no SECURITY.md)'];

test('every relative link in the README and docs/ resolves, to a heading where it names one', () => {
  assert.deepEqual(
    brokenLinks().filter((b) => !PENDING.includes(b)),
    [],
    'fix the link, or the heading it points at (node scripts/doc-links.ts lists them)',
  );
});

test("anchors are GitHub's: code and punctuation dropped, repeats numbered", () => {
  assert.equal(slug('Checks in the page (`--checks-in page`)'), 'checks-in-the-page---checks-in-page');
  assert.equal(slug('The `v0` tag'), 'the-v0-tag');
  assert.equal(slug('result.json'), 'resultjson');
  assert.deepEqual([...anchors('# A\n## A\n```\n# not a heading\n```\n### B')], ['a', 'a-1', 'b']);
  assert.deepEqual(links('[x](a.md#b) `[y](c.md)` ![i](img.png "t")\n```\n[z](d.md)\n```'), ['a.md#b', 'img.png']);
});

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
