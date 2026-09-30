/**
 * The esbuild adapter (ADR 0007): Vite-style apps are built in the browser
 * with esbuild-wasm from real npm packages, Tailwind v4 included, and build
 * errors are app bugs.
 *
 * Dependencies are installed on the host from the npm registry (cached in
 * .sandburg/installs), so the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';

const fixture = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

test('a Vite + React app is built with esbuild-wasm and passes its checks', async () => {
  const result = await session.run(fixture, { runtime: 'esbuild', checks: `${fixture}/checks.spec.ts`, outDir });
  assert.equal(result.runtime.name, 'esbuild');
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 2);
});

test('Tailwind CSS v4 (@tailwindcss/vite) is compiled with the app\'s own tailwindcss', async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ type: 'module', devDependencies: { vite: '^6.0.0', tailwindcss: '4.1.14', '@tailwindcss/vite': '4.1.14' } }),
      'vite.config.ts': "import { defineConfig } from 'vite';\nimport tailwindcss from '@tailwindcss/vite';\nexport default defineConfig({ plugins: [tailwindcss()] });\n",
      'index.html': '<!doctype html><html><body><h1 class="text-2xl font-bold text-[#123456]">Hi</h1><script type="module" src="/main.js"></script></body></html>',
      'main.js': "import './style.css';\n",
      'style.css': '@import "tailwindcss";\n',
    },
    { name: 'tailwind-v4', path: '/virtual/tailwind-v4' },
  );
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-tw-'));
  const checks = join(dir, 'checks.spec.ts');
  await writeFile(
    checks,
    `export default {
  'utility classes are generated': async ({ app, expect }) => {
    const h1 = app.getByRole('heading', { name: 'Hi' });
    await expect(h1).toHaveCSS('font-size', '24px');
    await expect(h1).toHaveCSS('font-weight', '700');
    await expect(h1).toHaveCSS('color', 'rgb(18, 52, 86)');
  },
};
`,
  );
  const result = await session.run(project, { runtime: 'esbuild', checks, outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
});

test('a syntax error is a build failure classified as an app bug', async () => {
  const base = await loadProject(fixture);
  const broken = projectFromFiles({ ...base.files, 'src/App.tsx': 'export default function App() {\n  return <div>;\n}\n' }, { name: 'vite-broken', path: fixture });
  const result = await session.run(broken, { runtime: 'esbuild', outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug');
  assert.match(result.failure!.message, /src\/App\.tsx:\d+:\d+/);
});

test('Vite plugins that the build cannot apply are unsupported, not failures', async () => {
  const base = await loadProject(fixture);
  const project = projectFromFiles(
    { ...base.files, 'vite.config.ts': "import svgr from 'vite-plugin-svgr';\nexport default { plugins: [svgr()] };\n" },
    { name: 'vite-svgr', path: fixture },
  );
  const result = await session.run(project, { runtime: 'esbuild', outDir });
  assert.equal(result.failure?.class, 'runtime-unsupported');
  assert.match(result.failure!.message, /vite-plugin-svgr/);
});
