/**
 * End-to-end: real Chromium and the node runtime: the Vite + React fixture runs
 * on its own Vite dev server, Next.js on next dev. The first run needs network
 * access to the npm registry; later runs use caches.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';
import type { Project } from '../../src/types.ts';

const fixtureDir = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
let session: Session;
let counter: Project;

before(async () => {
  session = new Session();
  await session.open();
  counter = await loadProject(fixtureDir);
});
after(() => session.close());

/** The counter fixture with some files replaced. */
function variant(name: string, files: Record<string, string>): Project {
  return projectFromFiles({ ...counter.files, ...files }, { name, path: `${fixtureDir}#${name}` });
}

test('milestone 1: the Vite + React fixture runs and its functional checks pass', async () => {
  const result = await session.run(counter, { checks: `${fixtureDir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks, null, 2));
  assert.equal(result.failure, null);
  assert.equal(result.runtime.name, 'node');
  const functional = result.checks.filter((c) => c.kind === 'functional');
  assert.equal(functional.length, 2);
  assert.ok(functional.every((c) => c.status === 'passed'));
  for (const key of ['loadMs', 'mountMs', 'installMs', 'startMs', 'readyMs', 'checksMs'] as const) {
    assert.equal(typeof result.timings[key], 'number', key);
  }
  // The versions npm installed for the declared ranges (^18.3.1).
  assert.match(result.install?.dependencies?.react ?? '', /^18\.\d+\.\d+$/);
  assert.match(result.install?.dependencies?.['react-dom'] ?? '', /^18\.\d+\.\d+$/);
  assert.ok(result.artifacts.screenshot);
  await access(result.artifacts.screenshot);

  // Schema stability: every run carries exactly the top-level fields of schema v1.
  const schema = JSON.parse(await readFile(new URL('../../src/result-schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(result).sort(), [...schema.required].sort());
  assert.deepEqual(Object.keys(result.timings).sort(), [...schema.properties.timings.required].sort());
});

test('a failing functional check is classified as an app bug', async () => {
  const project = variant('off-by-one', {
    'src/App.tsx': (counter.files['src/App.tsx'] as string).replace('setCount((c) => c + 1)', 'setCount((c) => c + 2)'),
  });
  const result = await session.run(project, {
    outDir,
    checks: {
      'counter increments by one': async ({ app, expect }) => {
        await app.getByRole('button', { name: /count is/ }).click();
        await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 1', { timeout: 2000 });
      },
    },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['app-bug', 'blocking-check-failed']);
});

test('requests outside the allowlist are blocked and recorded', async () => {
  const project = variant('exfiltrate', {
    'src/main.tsx':
      (counter.files['src/main.tsx'] as string) +
      `\nfetch('https://example.com/collect').catch(() => {});\nfetch('http://192.0.2.1:8080/').catch(() => {});\nfetch('http://127.0.0.1:1/').catch(() => {});\n`,
  });
  const result = await session.run(project, { outDir });
  const blocked = result.network.blocked.map((b) => new URL(b.url).origin);
  assert.ok(blocked.includes('https://example.com'), JSON.stringify(result.network));
  assert.ok(blocked.includes('http://192.0.2.1:8080'), JSON.stringify(result.network));
  // localhost is the sandbox: the page's calls to a local port go to its own servers, never out.
  assert.ok(!JSON.stringify(result.network).includes('127.0.0.1'), JSON.stringify(result.network));
  const networkCheck = result.checks.find((c) => c.kind === 'network');
  assert.equal(networkCheck?.status, 'failed');
  assert.equal(networkCheck?.blocking, false);
});

test('importing an undeclared package is an app bug, not a runtime limitation', async () => {
  const project = variant('undeclared', {
    // Used, so TypeScript import elision keeps it.
    'src/App.tsx': `import debounce from 'lodash/debounce';\nconsole.log(debounce);\n` + (counter.files['src/App.tsx'] as string),
  });
  const result = await session.run(project, { outDir, timeouts: { ready: 10_000 } });
  assert.equal(result.status, 'error');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['app-bug', 'undeclared-import']);
});

test('a ready deadline produces a timeout', async () => {
  const result = await session.run(counter, { outDir, readySelector: '#never', timeouts: { ready: 3000 } });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'timeout');
  assert.equal(result.phases.find((p) => p.name === 'ready')?.status, 'timeout');
});

test('projects the runtime cannot start are rejected before a tab opens', async () => {
  const library = projectFromFiles(
    { 'package.json': JSON.stringify({ name: 'a-library', scripts: { test: 'node --test' } }), 'lib.js': 'module.exports = 1;' },
    { name: 'a-library', path: 'a-library' },
  );
  const result = await session.run(library, { outDir });
  assert.equal(result.status, 'error');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['runtime-unsupported', 'probe-unsupported']);
  assert.equal(result.timings.loadMs, null);
});

const nextDir = fileURLToPath(new URL('../../fixtures/next-app-router', import.meta.url));

test('a broken Next.js API route is an app bug', async () => {
  const next = await loadProject(nextDir);
  const project = projectFromFiles(
    { ...next.files, 'app/api/greeting/route.ts': `export async function GET() { throw new Error('database unavailable'); }` },
    { name: 'next-broken-api', path: `${nextDir}#broken-api` },
  );
  const result = await session.run(project, { checks: `${nextDir}/checks.spec.ts`, outDir });
  assert.equal(result.runtime.name, 'node');
  assert.equal(result.status, 'failed');
  assert.deepEqual([result.failure?.class, result.failure?.rule], ['app-bug', 'blocking-check-failed']);
  assert.equal(result.checks.find((c) => c.name === 'API route answers')?.status, 'failed');
  assert.equal(result.checks.find((c) => c.name === 'a habit can be added')?.status, 'passed');
});
