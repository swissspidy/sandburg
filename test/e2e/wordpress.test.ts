/**
 * Milestone 5: a WordPress plugin runs in WordPress Playground and its
 * front-end and admin behavior is checked end to end. Needs network access to
 * playground.wordpress.net on the first run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { projectFromFiles, loadProject } from '../../src/project.ts';

const dir = fileURLToPath(new URL('../../fixtures/wordpress-reading-time', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
const TIMEOUTS = { mount: 180_000, install: 60_000, start: 60_000, ready: 90_000, checks: 240_000, check: 90_000 };

test('milestone 5: the Reading Time plugin runs in WordPress Playground', async () => {
  const session = new Session();
  await session.open();
  try {
    const result = await session.run(dir, { runtime: 'wordpress', checks: `${dir}/checks.spec.ts`, outDir, timeouts: TIMEOUTS });
    assert.equal(result.project.framework, 'wordpress');
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
    assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 2);

    // A fatal error in the plugin is caught at activation and classified as an app bug.
    const plugin = await loadProject(dir);
    const broken = projectFromFiles(
      { ...plugin.files, 'reading-time.php': (plugin.files['reading-time.php'] as string).replace("const READING_TIME_OPTION = 'reading_time_wpm';", "const READING_TIME_OPTION = 'reading_time_wpm';\nundefined_function_call();") },
      { name: 'reading-time-broken', path: `${dir}#broken` },
    );
    const bad = await session.run(broken, { runtime: 'wordpress', checks: `${dir}/checks.spec.ts`, outDir, timeouts: TIMEOUTS });
    assert.equal(bad.status, 'error');
    assert.deepEqual([bad.failure?.class, bad.failure?.phase, bad.failure?.rule], ['app-bug', 'install', 'adapter-code:APP']);
  } finally {
    await session.close();
  }
});
