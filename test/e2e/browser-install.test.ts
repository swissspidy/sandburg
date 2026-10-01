/**
 * The opt-in browser install (`installIn: 'browser'`, ADR 0018): the page resolves and fetches the
 * project's packages from the npm registry itself, and the host only serves the page and compiles
 * modules. Needs network access to the registry.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { projectFromFiles } from '../../src/project.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

const failures = (r: Awaited<ReturnType<Session['run']>>) => JSON.stringify(r.failure ?? r.checks.filter((c) => c.status !== 'passed'), null, 2);

for (const name of ['vite-react-counter', 'react-express-split', 'next-app-router']) {
  test(`${name} runs with its packages installed in the browser`, async () => {
    const dir = fixture(name);
    const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir, installIn: 'browser' });
    assert.equal(result.status, 'passed', failures(result));
  });
}

const app = (dependencies: Record<string, string>) =>
  projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'app', private: true, scripts: { dev: 'node server.js' }, dependencies }),
      'server.js': "require('http').createServer((q, s) => s.end('ok')).listen(3000);",
    },
    { name: 'browser-install-deps', path: 'browser-install-deps' },
  );

test('a package the registry does not have is an app bug, as with npm', async () => {
  const result = await session.run(app({ 'sandburg-no-such-package-3f9a1c': '^1.0.0' }), { outDir, installIn: 'browser' });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.equal(result.failure?.rule, 'unresolvable-dependency');
});

test('a git dependency is not supported in the browser install', async () => {
  const result = await session.run(app({ x: 'github:user/x' }), { outDir, installIn: 'browser' });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'runtime-unsupported', failures(result));
});
