/** A project or checks file that does not load ends its run as an error result, not its batch (Session.runOnce). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../../src/orchestrator/session.ts';
import { runBatch } from '../../src/orchestrator/batch.ts';
import type { RunResult } from '../../src/types.ts';
import { tempDir } from './temp-dir.ts';

/** A session whose browser is never reached: a run that fails to load ends before it takes a tab. */
function session(dir: string): Session {
  const s = new Session({ storeDir: join(dir, 'store') });
  (s as unknown as { browser: object }).browser = { version: () => '1.0' };
  return s;
}

test("a project that does not load is an error result, recorded in the run's directory", async () => {
  const dir = tempDir('sandburg-setup-');
  const outDir = join(dir, 'runs');
  const result = await session(dir).run(join(dir, 'missing'), { outDir });
  assert.equal(result.status, 'error');
  assert.deepEqual({ ...result.failure, message: undefined }, { class: 'app-bug', phase: 'probe', rule: 'project-load', message: undefined, evidence: [] });
  assert.match(result.failure!.message, /ENOENT/);
  assert.equal(result.project.name, 'missing');
  assert.deepEqual(result.phases.map((p) => [p.name, p.status]), [['probe', 'failed'], ['load', 'skipped'], ['mount', 'skipped'], ['install', 'skipped'], ['start', 'skipped'], ['ready', 'skipped'], ['checks', 'skipped'], ['dispose', 'skipped']]);
  // Not retried (it is not infra): one run, its result on disk.
  assert.deepEqual(await readdir(outDir), [result.runId]);
  assert.deepEqual(JSON.parse(await readFile(join(outDir, result.runId, 'result.json'), 'utf8')), result);
});

test('a checks file that cannot be imported is an error result', async () => {
  const dir = tempDir('sandburg-setup-');
  await writeFile(join(dir, 'index.html'), '<p>hi</p>');
  const checks = join(dir, 'broken.checks.mjs');
  await writeFile(checks, 'export default {');
  const result = await session(dir).run(dir, { checks, outDir: join(dir, 'runs') });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.rule, 'checks-load');
  assert.equal(result.failure?.class, 'app-bug');
  assert.match(result.failure?.message ?? '', /SyntaxError|Unexpected/);
});

test('a batch with projects that do not load completes, with an error result for each, and writes its summary', async () => {
  const dir = tempDir('sandburg-setup-');
  await writeFile(join(dir, 'bad.json'), '{ not json');
  await writeFile(join(dir, 'bad.zip'), 'not a zip');
  const results: RunResult[] = [];
  const { summary } = await runBatch(session(dir), [{ project: join(dir, 'bad.json') }, { project: join(dir, 'bad.zip') }, { project: join(dir, 'gone') }], {
    prewarm: false,
    outDir: join(dir, 'runs'),
    batchDir: join(dir, 'batches'),
    onResult: (r) => results.push(r),
  });
  assert.equal(results.length, 3);
  assert.deepEqual(summary.totals, { runs: 3, passed: 0, failed: 0, error: 3, byClass: { 'app-bug': 3 }, cacheHits: 0, cacheMisses: 0, blockedRequests: 0 });
  assert.deepEqual(summary.runs.map((r) => r.failureRule), ['project-load', 'project-load', 'project-load']);
  assert.ok(JSON.parse(await readFile(join(dir, 'batches', summary.batchId, 'summary.json'), 'utf8')));
});
