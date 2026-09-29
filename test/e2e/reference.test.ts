/**
 * Milestone 4: the Docker reference runs the same fixtures with real npm and
 * real dev servers, and `compare` pairs the results. Skipped without Docker.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { dockerReference } from '../../src/reference/docker.ts';
import { discoverProjects } from '../../src/orchestrator/batch.ts';
import { compare } from '../../src/compare/compare.ts';
import { renderReport } from '../../src/compare/report.ts';

const fixtures = fileURLToPath(new URL('../../fixtures', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
const batchDir = fileURLToPath(new URL('../../.sandburg/test-batches', import.meta.url));
const REF_TIMEOUTS = { install: 600_000, start: 180_000, ready: 180_000 };

let docker = true;
try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
} catch {
  docker = false;
}

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session.close());

test('the Docker reference runs the Next.js fixture with real npm and next dev', { skip: !docker && 'Docker is not available' }, async () => {
  const dir = join(fixtures, 'next-app-router');
  const result = await session.run(dir, { nodeRuntime: dockerReference(), checks: join(dir, 'checks.spec.ts'), outDir, timeouts: REF_TIMEOUTS });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  assert.equal(result.runtime.name, 'docker');
  assert.ok(result.artifacts.runtimeLog, 'runtime log is kept');
  assert.equal(result.install?.resolution, 'range');
});

test('compare pairs browser and reference results and agrees on both fixtures', { skip: !docker && 'Docker is not available' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-compare-'));
  try {
    await cp(join(fixtures, 'vite-react-counter'), join(dir, 'vite-react-counter'), { recursive: true });
    await cp(join(fixtures, 'next-app-router'), join(dir, 'next-app-router'), { recursive: true });
    const report = await compare(session, await discoverProjects(dir), {
      reference: { name: 'docker', factory: dockerReference() },
      outDir,
      batchDir,
      parallel: 2,
      referenceParallel: 2,
      referenceTimeouts: REF_TIMEOUTS,
    });
    assert.equal(report.overall.n, 2);
    assert.equal(report.overall.agreement, 1, JSON.stringify(report.pairs, null, 2));
    assert.equal(report.overall.bothPass, 2);
    assert.ok(report.timing.reference.medianMs > 0 && report.timing.browser.medianMs > 0);
    assert.match(renderReport(report), /\| \*\*All\*\* \| 2 \| \*\*100\.0%\*\*/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
