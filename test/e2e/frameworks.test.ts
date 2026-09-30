/**
 * Client frameworks in the esbuild adapter (ADR 0011), from their official
 * create-vite templates: each app's own compiler runs in the browser
 * (svelte/compiler, babel-preset-solid), Preact through @preact/preset-vite's
 * aliases, Lit with the project's TypeScript decorator settings.
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

const failures = (r: Awaited<ReturnType<Session['run']>>) => JSON.stringify(r.failure ?? r.checks.filter((c) => c.status !== 'passed'), null, 2);

for (const name of ['svelte-vite', 'solid-vite', 'preact-vite', 'lit-vite']) {
  test(`${name} (create-vite template) runs and passes its checks`, async () => {
    const dir = fixture(name);
    const result = await session.run(dir, { runtime: 'esbuild', checks: `${dir}/checks.spec.ts`, outDir });
    assert.equal(result.status, 'passed', failures(result));
  });
}

test('a Svelte syntax error is an app bug with its location', async () => {
  const dir = fixture('svelte-vite');
  const base = await loadProject(dir);
  const counter = (base.files['src/lib/Counter.svelte'] as string).replace('Count is {count}', 'Count is {count');
  const result = await session.run(projectFromFiles({ ...base.files, 'src/lib/Counter.svelte': counter }, { name: 'svelte-error', path: dir }), { runtime: 'esbuild', outDir });
  assert.equal(result.failure?.class, 'app-bug', failures(result));
  assert.match(result.failure!.message, /src\/lib\/Counter\.svelte:\d+:\d+/);
});

test('a Svelte component with <style lang="scss"> is unsupported, not an app bug', async () => {
  const dir = fixture('svelte-vite');
  const base = await loadProject(dir);
  const counter = `${base.files['src/lib/Counter.svelte'] as string}\n<style lang="scss">\n  $c: red;\n  button { color: $c; }\n</style>\n`;
  const result = await session.run(projectFromFiles({ ...base.files, 'src/lib/Counter.svelte': counter }, { name: 'svelte-scss', path: dir }), { runtime: 'esbuild', outDir });
  assert.equal(result.failure?.class, 'runtime-unsupported', failures(result));
  assert.match(result.failure!.message, /lang="scss"/);
});
