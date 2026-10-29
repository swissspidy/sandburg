/**
 * End-to-end: .sandburg cleared while the process keeps running (a test runner, a server), between
 * two sessions (issue #117). The second session's batch installs again, and passes: nothing the
 * process kept of the first session's installs is trusted once they are gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything the installer keeps (installs, the package store, transforms, dev caches, …) is under
// this .sandburg, set before the node adapter is loaded; the session's own directories are too.
const root = mkdtempSync(join(tmpdir(), 'sandburg-cleared-'));
const sandburg = join(root, '.sandburg');
process.env.SANDBURG_INSTALL_DIR = join(sandburg, 'installs');
const { Session } = await import('../../src/orchestrator/session.ts');
const { discoverProjects, runBatch } = await import('../../src/orchestrator/batch.ts');

const corpus = fileURLToPath(new URL('../../corpus', import.meta.url));

test('a batch passes again in a new session after .sandburg is removed in the same process', { timeout: 300_000 }, async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const items = (await discoverProjects(corpus)).filter((i) => i.label === '000-vite-react');
  assert.equal(items.length, 1);
  const pass = async () => {
    const session = new Session({ storeDir: join(sandburg, 'store'), cacheDir: join(sandburg, 'cache'), codeCacheDir: join(sandburg, 'code-cache') });
    await session.open();
    try {
      const { results } = await runBatch(session, items, { prewarm: false, batchDir: join(sandburg, 'batches') });
      return results[0];
    } finally {
      await session.close();
    }
  };
  const first = await pass();
  assert.equal(first.status, 'passed', JSON.stringify(first.failure, null, 2));
  rmSync(sandburg, { recursive: true, force: true });
  const second = await pass();
  assert.equal(second.status, 'passed', JSON.stringify(second.failure, null, 2));
});
