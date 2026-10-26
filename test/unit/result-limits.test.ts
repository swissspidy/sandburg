import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { RunState } from '../../src/orchestrator/run-state.ts';
import { TEXT_MAX, capText } from '../../src/orchestrator/limits.ts';
import { projectFromFiles } from '../../src/project.ts';

const BIG = 50 * 1024 * 1024;

test('capText keeps the first characters and says how many more there were', () => {
  assert.equal(capText('short'), 'short');
  assert.equal(capText('abcdef', 3), 'abc… (3 more characters)');
  // What was capped stays as it is when capped again.
  assert.equal(capText(capText('abcdef', 3), 3), 'abc… (3 more characters)');
});

test('an app that throws, logs and fails a check with 50 MB strings leaves a small result.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-limits-'));
  try {
    const huge = 'x'.repeat(BIG);
    const run = new RunState('run-1', projectFromFiles({ 'index.html': '<p>hi</p>' }, { name: 'p', path: '/p' }), { name: 'node', version: '1' }, false, 'chromium');
    // The page: an uncaught error and a console error, each of 50 MB.
    const page = new EventEmitter();
    run.capture(page as unknown as Page, 'http://s.sandburg.localhost:1');
    page.emit('pageerror', Object.assign(new Error(huge), { stack: `Error: ${huge}\n    at http://s.sandburg.localhost:1/app.js:1:1` }));
    page.emit('console', { type: () => 'error', text: () => huge, location: () => ({ url: 'http://s.sandburg.localhost:1/app.js' }) });
    // A phase that fails with a 50 MB message, and a blocking check whose message quotes the page.
    await assert.rejects(run.phase('start', 1000, () => Promise.reject(new Error(huge))));
    await run.phase('checks', 1000, async () => {
      run.checksOutput = { checks: [{ id: 'c', kind: 'functional', name: 'c', status: 'failed', blocking: true, durationMs: 1, message: huge }], artifacts: {} };
    });
    const result = await run.finish(dir);
    const file = join(dir, 'result.json');
    assert.ok((await stat(file)).size < 512 * 1024, `result.json is ${(await stat(file)).size} bytes`);
    const marker = `… (${BIG - TEXT_MAX} more characters)`;
    const start = result.phases.find((p) => p.name === 'start')!;
    assert.ok(start.error!.message.endsWith(marker));
    assert.equal(start.error!.message.length, TEXT_MAX + marker.length);
    assert.ok(result.pageErrors[0].message.endsWith(marker));
    assert.ok(result.pageErrors[0].stack!.length < TEXT_MAX + 100);
    assert.ok(result.console[0].text.length < 2_100);
    assert.ok(result.checks[0].message!.endsWith(marker));
    assert.ok(result.failure, 'the run failed');
    assert.ok(result.failure.message.length < TEXT_MAX + 100);
    for (const e of result.failure.evidence) assert.ok(e.length < TEXT_MAX + 100);
    const written = JSON.parse(await readFile(file, 'utf8')) as typeof result;
    assert.equal(written.phases.find((p) => p.name === 'start')!.error!.message, start.error!.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
