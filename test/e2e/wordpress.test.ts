/**
 * Milestone 5: a WordPress plugin runs in WordPress Playground and its
 * front-end and admin behavior is checked end to end.
 *
 * Opt-in (SANDBURG_E2E_WORDPRESS=1): it depends on playground.wordpress.net,
 * a public service that rate-limits heavy use (HTTP 429). A run whose runtime
 * could not be loaded (infra, or a boot that never finished) is skipped, not
 * failed: it says nothing about the plugin or the adapter.
 */
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { projectFromFiles, loadProject } from '../../src/project.ts';
import type { RunResult } from '../../src/types.ts';

const dir = fileURLToPath(new URL('../../fixtures/wordpress-reading-time', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
const TIMEOUTS = { mount: 120_000, install: 60_000, start: 60_000, ready: 90_000, checks: 240_000, check: 90_000 };
const enabled = process.env.SANDBURG_E2E_WORDPRESS === '1';

let session: Session;
before(async () => {
  if (!enabled) return;
  session = new Session();
  await session.open();
});
after(() => session?.close());

function skipIfPlaygroundUnavailable(t: TestContext, r: RunResult): boolean {
  const bootFailed = r.failure?.class === 'infra' || (r.failure?.phase === 'mount' && r.failure.class === 'timeout');
  if (bootFailed) t.skip(`WordPress Playground could not be loaded: ${r.failure!.message.split('\n')[0]}`);
  return bootFailed;
}

test('milestone 5: the Reading Time plugin runs in WordPress Playground', { skip: !enabled && 'set SANDBURG_E2E_WORDPRESS=1' }, async (t) => {
  const result = await session.run(dir, { runtime: 'wordpress', checks: `${dir}/checks.spec.ts`, outDir, timeouts: TIMEOUTS, infraRetries: 2 });
  if (skipIfPlaygroundUnavailable(t, result)) return;
  assert.equal(result.project.framework, 'wordpress');
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 2);
});

test('a plugin with a fatal error fails at activation as an app bug', { skip: !enabled && 'set SANDBURG_E2E_WORDPRESS=1' }, async (t) => {
  const plugin = await loadProject(dir);
  const broken = projectFromFiles(
    {
      ...plugin.files,
      'reading-time.php': (plugin.files['reading-time.php'] as string).replace(
        "const READING_TIME_OPTION = 'reading_time_wpm';",
        "const READING_TIME_OPTION = 'reading_time_wpm';\nundefined_function_call();",
      ),
    },
    { name: 'reading-time-broken', path: `${dir}#broken` },
  );
  const result = await session.run(broken, { runtime: 'wordpress', checks: `${dir}/checks.spec.ts`, outDir, timeouts: TIMEOUTS, infraRetries: 2 });
  if (skipIfPlaygroundUnavailable(t, result)) return;
  assert.equal(result.status, 'error');
  assert.deepEqual([result.failure?.class, result.failure?.phase, result.failure?.rule], ['app-bug', 'install', 'adapter-code:APP']);
  assert.match(result.failure!.message, /undefined_function_call/);
});
