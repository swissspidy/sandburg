/** A project or checks file that does not load ends its run as an error result, not its batch (Session.runOnce). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from '../../src/orchestrator/session.ts';
import { runBatch } from '../../src/orchestrator/batch.ts';
import type { RunResult } from '../../src/types.ts';
import { tempDir } from './temp-dir.ts';
import { NO_SNAPSHOT } from '../../src/store.ts';

/** A session whose browser is never reached: a run that fails to load ends before it takes a tab. */
function session(dir: string): Session {
  const s = new Session({ storeDir: join(dir, 'store') });
  (s as unknown as { browser: object }).browser = { version: () => '1.0' };
  return s;
}

test("a project that is not there is an error result (unknown), recorded in the run's directory", async () => {
  const dir = tempDir('sandburg-setup-');
  const outDir = join(dir, 'runs');
  const result = await session(dir).run(join(dir, 'missing'), { outDir });
  assert.equal(result.status, 'error');
  assert.deepEqual({ ...result.failure, message: undefined }, { class: 'unknown', phase: 'probe', rule: 'project-load', message: undefined, evidence: [] });
  // No snapshot id of a tree (the empty tree's would be shared by every such run).
  assert.equal(result.project.snapshotId, NO_SNAPSHOT);
  assert.match(result.failure!.message, /ENOENT/);
  assert.equal(result.project.name, 'missing');
  assert.deepEqual(result.phases.map((p) => [p.name, p.status]), [['probe', 'failed'], ['load', 'skipped'], ['mount', 'skipped'], ['install', 'skipped'], ['start', 'skipped'], ['ready', 'skipped'], ['checks', 'skipped'], ['dispose', 'skipped']]);
  // Not retried (it is not infra): one run, its result on disk.
  assert.deepEqual(await readdir(outDir), [result.runId]);
  assert.deepEqual(JSON.parse(await readFile(join(outDir, result.runId, 'result.json'), 'utf8')), result);
});

test('a checks file that cannot be imported is an error result', async () => {
  const dir = tempDir('sandburg-setup-');
  const app = join(dir, 'app');
  await mkdir(app);
  await writeFile(join(app, 'index.html'), '<p>hi</p>');
  const checks = join(dir, 'broken.checks.mjs');
  await writeFile(checks, 'export default {');
  const result = await session(dir).run(app, { checks, outDir: join(dir, 'runs') });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.rule, 'checks-load');
  assert.equal(result.failure?.class, 'unknown');
  assert.match(result.failure?.message ?? '', /SyntaxError|Unexpected/);
  // The project was stored: the run can be reopened from its snapshot.
  const s = session(dir);
  assert.deepEqual((await s.store.get(result.project.snapshotId)).files, { 'index.html': '<p>hi</p>' });
});

test('a snapshot that is not stored is an error result (unknown) that says so', async () => {
  const dir = tempDir('sandburg-setup-');
  const result = await session(dir).run(`snapshot:${'a'.repeat(64)}`, { outDir: join(dir, 'runs') });
  assert.deepEqual([result.failure?.class, result.failure?.rule, result.failure?.message], ['unknown', 'project-load', `snapshot ${'a'.repeat(64)}: not found`]);
  assert.equal(result.project.path, `snapshot:${'a'.repeat(64)}`);
});

test("a batch with projects that do not load completes, with an error result for each, and writes its summary; a broken file is the project's bug", async () => {
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
  assert.deepEqual(summary.totals, { runs: 3, passed: 0, failed: 0, error: 3, byClass: { 'app-bug': 2, unknown: 1 }, cacheHits: 0, cacheMisses: 0, blockedRequests: 0 });
  assert.deepEqual(summary.runs.map((r) => r.failureRule), ['project-load', 'project-load', 'project-load']);
  assert.deepEqual(summary.runs.map((r) => r.failureClass), ['app-bug', 'app-bug', 'unknown']);
  assert.ok(JSON.parse(await readFile(join(dir, 'batches', summary.batchId, 'summary.json'), 'utf8')));
});

test("a batch's checks file loads only in the runs that use it: a broken one fails those runs, as checks-load", async () => {
  const dir = tempDir('sandburg-setup-');
  const app = join(dir, 'app');
  await mkdir(app);
  await writeFile(join(app, 'index.html'), '<p>hi</p>');
  const broken = join(dir, 'broken.checks.mjs');
  await writeFile(broken, 'export default {');
  const { results } = await runBatch(session(dir), [{ project: app }, { project: join(dir, 'gone') }], { prewarm: false, checks: broken, outDir: join(dir, 'runs'), batchDir: join(dir, 'batches') });
  assert.deepEqual(results.map((r) => r.failure?.rule), ['checks-load', 'project-load']);
});
