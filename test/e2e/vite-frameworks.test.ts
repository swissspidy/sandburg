/**
 * Real Vite 8 in the node runtime (ADR 0012): meta-frameworks run their own dev servers in the
 * browser — SvelteKit, Astro, React Router (framework mode, relaunched as a child process with
 * --conditions=development) and Nuxt (Nitro's server in a worker thread, vite-node over a local
 * socket) — with server rendering, hydration and client navigation. A plain Vite app runs on
 * real Vite too.
 *
 * Dependencies (and their WebAssembly builds) are installed on the host from the npm registry
 * (cached in .sandburg/installs), so the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
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

const cases: [string, string, string][] = [
  ['svelte-vite', 'vite', 'a Svelte app on real Vite'],
  ['sveltekit-app', 'sveltekit', 'SvelteKit (load(), hydration, client navigation)'],
  ['astro-app', 'astro', 'Astro 7 (frontmatter, client script, API endpoint)'],
  ['react-router-app', 'vite', 'React Router 8 framework mode (loader, action, hydration)'],
  ['nuxt-app', 'nuxt', 'Nuxt 4 (Nitro server route, useFetch, hydration)'],
];
for (const [name, framework, what] of cases) {
  test(`${what} runs on the node runtime`, async () => {
    const dir = fixture(name);
    const result = await session.run(dir, { runtime: 'node', checks: `${dir}/checks.spec.ts`, outDir });
    assert.equal(result.project.framework, framework);
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
  });
}

test('a SvelteKit load() that throws is an app bug', async () => {
  const project = await loadProject(fixture('sveltekit-app'));
  const broken = projectFromFiles(
    { ...project.files, 'src/routes/+page.server.ts': "export function load() {\n  throw new Error('database offline');\n}\n" },
    { name: 'sveltekit-broken-load', path: fixture('sveltekit-app') },
  );
  const result = await session.run(broken, { runtime: 'node', outDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.class, 'app-bug', JSON.stringify(result.failure, null, 2));
});
