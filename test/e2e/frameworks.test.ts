/**
 * Client-side Vite apps on their own Vite dev server in the node runtime (ADR 0014), from the
 * official create-vite templates: Svelte, Solid, Preact, Lit, Tailwind CSS v4. Compile errors in
 * the project's sources are app bugs, with their location.
 *
 * Dependencies are installed on the host from the npm registry (cached in .sandburg/installs), so
 * the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

const failures = (r: Awaited<ReturnType<Session['run']>>) => JSON.stringify(r.failure ?? r.checks.filter((c) => c.status !== 'passed'), null, 2);

for (const name of ['solid-vite', 'preact-vite', 'lit-vite']) {
  test(`${name} (create-vite template) runs and passes its checks`, async () => {
    const dir = fixture(name);
    const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
    assert.equal(result.status, 'passed', failures(result));
  });
}

test('Tailwind CSS v4 (@tailwindcss/vite) is compiled by the app\'s own tailwindcss', async () => {
  const project = projectFromFiles(
    {
      'package.json': JSON.stringify({ type: 'module', scripts: { dev: 'vite' }, devDependencies: { vite: '^6.0.0', tailwindcss: '4.1.14', '@tailwindcss/vite': '4.1.14' } }),
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
  const result = await session.run(project, { checks, outDir });
  assert.equal(result.status, 'passed', failures(result));
});

test('a TSX syntax error is an app bug with its location', async () => {
  const dir = fixture('vite-react-counter');
  const base = await loadProject(dir);
  const broken = projectFromFiles({ ...base.files, 'src/App.tsx': 'export default function App() {\n  return <div>;\n}\n' }, { name: 'vite-broken', path: dir });
  const result = await session.run(broken, { outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.match(result.failure!.message, /src\/App\.tsx:\d+:\d+/);
});

test('a Svelte syntax error is an app bug with its location', async () => {
  const dir = fixture('svelte-vite');
  const base = await loadProject(dir);
  const counter = (base.files['src/lib/Counter.svelte'] as string).replace('Count is {count}', 'Count is {count');
  const result = await session.run(projectFromFiles({ ...base.files, 'src/lib/Counter.svelte': counter }, { name: 'svelte-error', path: dir }), { outDir });
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.match(result.failure!.message, /src\/lib\/Counter\.svelte:\d+:\d+/);
});

test('<style lang="scss"> without a preprocessor is an app bug', async () => {
  const dir = fixture('svelte-vite');
  const base = await loadProject(dir);
  const counter = `${base.files['src/lib/Counter.svelte'] as string}\n<style lang="scss">\n  $c: red;\n  button { color: $c; }\n</style>\n`;
  const result = await session.run(projectFromFiles({ ...base.files, 'src/lib/Counter.svelte': counter }, { name: 'svelte-scss', path: dir }), { outDir });
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.match(result.failure!.message, /src\/lib\/Counter\.svelte:\d+:\d+/);
});
