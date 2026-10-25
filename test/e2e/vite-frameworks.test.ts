/**
 * Real Vite 8 in the node runtime (ADR 0012): meta-frameworks run their own dev servers in the
 * browser — SvelteKit, Astro, React Router (framework mode, relaunched as a child process with
 * --conditions=development) and Nuxt (Nitro's server in a worker thread, vite-node over a local
 * socket) and SolidStart — with server rendering, hydration and client navigation. A plain Vite app runs on
 * real Vite too.
 *
 * Dependencies (and their WebAssembly builds) are installed on the host from the npm registry
 * (cached in .sandburg/installs), so the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  ['react-router-app', 'react-router', 'React Router 8 framework mode (loader, action, hydration)'],
  ['nuxt-app', 'nuxt', 'Nuxt 4 (Nitro server route, useFetch, hydration)'],
  ['solid-start-app', 'solid-start', 'SolidStart 2 (server function, action, API route)'],
];
for (const [name, framework, what] of cases) {
  test(`${what} runs on the node runtime`, async () => {
    const dir = fixture(name);
    const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
    assert.equal(result.project.framework, framework);
    assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks.filter((c) => c.status !== 'passed'), null, 2));
    // react-router dev starts with --conditions=development (adapters/node/browser.ts) instead of relaunching itself.
    if (framework === 'react-router') assert.deepEqual(result.console.filter((c) => /Relaunching/.test(c.text)).map((c) => c.text), []);
  });
}

test('a second run of a SvelteKit app starts from the dependencies its first run pre-bundled', async () => {
  const dir = fixture('sveltekit-app');
  for (let i = 0; i < 2; i++) {
    const result = await session.run(dir, { outDir });
    assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
    if (i === 0) continue;
    // Both environments' (client and ssr) and vite-plugin-svelte's metadata were kept.
    const optimizer = result.console.filter((c) => /re-optimiz|bundling dependencies/.test(c.text)).map((c) => c.text);
    assert.deepEqual(optimizer, []);
  }
});

/** The runtime's transform cache entries for /app/src/app.tsx in the stored dev-server caches: the sources they were compiled from, by cache file. */
async function storedAppCompiles(): Promise<Map<string, string[]>> {
  const dir = fileURLToPath(new URL('../../.sandburg/dev-cache', import.meta.url));
  const found = new Map<string, string[]>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
    const files = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
    const sources = Object.entries(files)
      .filter(([path]) => path.startsWith('node_modules/.vite/sandburg-transforms/vite-plugin-solid/'))
      .map(([, text]) => JSON.parse(text as string) as { id: string; source: string })
      .filter((e) => e.id === '/app/src/app.tsx')
      .map((e) => e.source);
    if (sources.length) found.set(name, sources);
  }
  return found;
}

test("a SolidStart app's Babel compiles are kept for its next run, and only for that project", async () => {
  const dir = fixture('solid-start-app');
  const project = await loadProject(dir);
  const original = project.files['src/app.tsx'] as string;
  const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure, null, 2));
  const before = await storedAppCompiles();
  const own = [...before].filter(([, sources]) => sources.some((s) => s.startsWith(original.slice(0, 200))) && !sources.some((s) => s.includes('// edited')));
  assert.ok(own.length > 0, 'the run kept its compile of src/app.tsx');
  // Another project (one file differs) starts from a cache of its own: its compile is of its own source.
  const edited = `${original}\n// edited\n`;
  const copy = projectFromFiles({ ...project.files, 'src/app.tsx': edited }, { name: 'solid-start-edited', path: dir });
  const second = await session.run(copy, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(second.status, 'passed', JSON.stringify(second.failure ?? second.checks.filter((c) => c.status !== 'passed'), null, 2));
  const after = await storedAppCompiles();
  // A cache file of the copy's: its compiles of src/app.tsx (for the server and the client, after the
  // plugins before vite-plugin-solid) are all of the edited source.
  const copies = [...after].filter(([, sources]) => sources.some((s) => s.includes('// edited')));
  assert.equal(copies.length, 1, JSON.stringify([...after].map(([name, sources]) => [name, sources.length])));
  assert.ok(copies[0][1].every((s) => s.includes('// edited')));
  // The first project's cache is as it was.
  for (const [name, sources] of own) assert.deepEqual(after.get(name), sources);
});

test('a SvelteKit load() that throws is an app bug', async () => {
  const project = await loadProject(fixture('sveltekit-app'));
  const broken = projectFromFiles(
    { ...project.files, 'src/routes/+page.server.ts': "export function load() {\n  throw new Error('database offline');\n}\n" },
    { name: 'sveltekit-broken-load', path: fixture('sveltekit-app') },
  );
  const result = await session.run(broken, { outDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.class, 'app-bug', JSON.stringify(result.failure, null, 2));
});
