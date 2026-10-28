/**
 * Monorepos and local packages (ADR 0063): npm and pnpm workspaces, file: and link: dependencies,
 * a run of a workspace package, the versions a pnpm-lock.yaml pins, with either install; and what
 * neither install can give a project, said before anything is installed. Needs the npm registry
 * (the first time).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { projectFromFiles } from '../../src/project.ts';
import type { Checks } from '../../src/orchestrator/checks.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

const failures = (r: Awaited<ReturnType<Session['run']>>) => JSON.stringify(r.failure ?? r.checks.filter((c) => c.status !== 'passed'), null, 2);

for (const installIn of ['host', 'browser'] as const) {
  test(`an npm workspaces monorepo runs from its root, its package-lock.json honoured (install: ${installIn})`, async () => {
    const result = await session.run(fixture('monorepo-workspaces'), { checks: fixture('monorepo-workspaces/checks.spec.ts'), outDir, installIn });
    assert.equal(result.status, 'passed', failures(result));
    assert.equal(result.install?.dependencies.ms, '2.1.2');
    assert.equal(result.install?.lockfileHonored, true);
  });

  test(`a workspace package runs in its monorepo (install: ${installIn})`, async () => {
    const result = await session.run(fixture('monorepo-workspaces/apps/web'), { checks: fixture('monorepo-workspaces/checks.spec.ts'), outDir, installIn });
    assert.equal(result.status, 'passed', failures(result));
  });

  test(`a pnpm workspace with workspace: and link: packages, at the versions its pnpm-lock.yaml pins (install: ${installIn})`, async () => {
    const result = await session.run(fixture('pnpm-lock-app'), { checks: fixture('pnpm-lock-app/checks.spec.ts'), outDir, installIn });
    assert.equal(result.status, 'passed', failures(result));
    // ^2.0.0 would be 2.1.3 without the lockfile.
    assert.equal(result.install?.dependencies.ms, '2.0.0');
    assert.equal(result.install?.resolution, 'lockfile');
    assert.equal(result.install?.lockfileHonored, true);
  });
}

test('a Vite app in a workspace imports a workspace package, run from the root and from its directory', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'vite-mono', private: true, workspaces: ['apps/*', 'packages/*'], scripts: { dev: 'npm run dev -w web' } }),
    'apps/web/package.json': JSON.stringify({ name: 'web', private: true, type: 'module', scripts: { dev: 'vite' }, dependencies: { '@acme/ui': '*' }, devDependencies: { vite: '^8.0.0' } }),
    'apps/web/index.html': '<!doctype html><html lang="en"><head><title>Vite mono</title></head><body><main id="app"></main><script type="module" src="/src/main.js"></script></body></html>',
    'apps/web/src/main.js': "import { badge } from '@acme/ui';\ndocument.querySelector('#app').innerHTML = `<h1>${badge('vite')}</h1>`;\n",
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', version: '0.0.1', type: 'module', exports: './src/index.js', dependencies: { ms: '^2.1.0' } }),
    'packages/ui/src/index.js': "import ms from 'ms';\nexport const badge = (name) => `${name} in a workspace (${ms(1000)})`;\n",
  };
  const checks: Checks = { 'renders the workspace package': async ({ app, expect }) => expect(app.getByRole('heading')).toHaveText('vite in a workspace (1s)') };
  const root = projectFromFiles(files, { name: 'vite-mono', path: 'vite-mono' });
  for (const project of [root, { ...root, name: 'web', app: 'apps/web' }]) {
    const result = await session.run(project, { checks, outDir });
    assert.equal(result.status, 'passed', failures(result));
  }
});

const app = (dependencies: Record<string, string>) =>
  projectFromFiles(
    {
      'package.json': JSON.stringify({ name: 'app', private: true, scripts: { dev: 'node server.js' }, dependencies }),
      'server.js': "require('http').createServer((q, s) => s.end('ok')).listen(3000);",
    },
    { name: 'monorepo-unsupported', path: 'monorepo-unsupported' },
  );

for (const [dep, spec, kind] of [
  ['a', 'git+https://github.com/user/a.git', /a git repository dependency/],
  ['b', 'user/b', /a GitHub repository \(user\/repo\) dependency/],
  ['c', 'https://example.com/c.tgz', /a URL dependency/],
  ['d', 'file:../outside', /outside the project/],
] as const) {
  test(`${spec}: runtime-unsupported before anything is installed, naming the dependency`, async () => {
    for (const installIn of ['host', 'browser'] as const) {
      const result = await session.run(app({ [dep]: spec }), { outDir, installIn });
      assert.equal(result.status, 'error');
      assert.equal(result.failure?.class, 'runtime-unsupported', failures(result));
      assert.equal(result.failure?.phase, 'probe', failures(result));
      assert.ok(result.failure?.message.startsWith(`${dep}@${spec}: `), failures(result));
      assert.match(result.failure?.message ?? '', kind);
    }
  });
}
