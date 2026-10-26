import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectFramework, FRAMEWORKS } from '../../src/framework.ts';
import type { Framework } from '../../src/types.ts';

// The framework table (src/framework.ts) is the one place a framework is added; these keep the
// rest in step with it. The Framework union in types.ts is checked by the table's type
// (a Record over it): a name in one and not the other does not compile.

test("result-schema.json's framework enum is the table's frameworks and 'unknown'", () => {
  const schema = JSON.parse(readFileSync('src/result-schema.json', 'utf8')) as { properties: { project: { properties: { framework: { enum: string[] } } } } };
  assert.deepEqual(schema.properties.project.properties.framework.enum.sort(), [...Object.keys(FRAMEWORKS), 'unknown'].sort());
});

test('detection: the table in order, frameworks built on Vite before Vite', () => {
  const vite = { vite: '7' };
  const cases: [Framework, Record<string, string>, Record<string, string>, boolean?][] = [
    ['next', { next: '16', react: '19' }, {}],
    ['next', {}, { 'next.config.mjs': '' }],
    ['angular', { '@angular/core': '20', ...vite }, {}],
    ['angular', {}, { 'angular.json': '{}' }],
    ['sveltekit', { '@sveltejs/kit': '2', ...vite, astro: '5' }, {}],
    ['astro', { astro: '5', ...vite }, {}],
    ['astro', {}, { 'astro.config.ts': '' }],
    ['nuxt', { nuxt: '4', ...vite }, {}],
    ['nuxt', {}, { 'nuxt.config.ts': '' }],
    ['solid-start', { '@solidjs/start': '1', ...vite }, {}],
    ['react-router', { '@react-router/dev': '7', ...vite }, {}],
    ['vite', vite, {}],
    ['vite', {}, { 'vite.config.cts': '' }],
    ['static', {}, { 'index.html': '' }, true],
    ['unknown', {}, { 'index.html': '' }],
    ['unknown', { express: '5' }, { 'server.js': '' }],
  ];
  for (const [expected, deps, files, noPackage] of cases) {
    assert.equal(detectFramework(files, noPackage ? null : { devDependencies: deps }), expected, `${JSON.stringify(deps)} ${JSON.stringify(files)}`);
  }
});

test('every framework the Docker reference starts has a dev server command line', () => {
  for (const [name, info] of Object.entries(FRAMEWORKS)) {
    if (!info.reference) continue;
    assert.ok(info.reference.listen('127.0.0.1', 4000).includes('4000'), name);
    assert.match(info.reference.script({ scripts: { dev: 'x' } }), /^(dev|start)$/, name);
  }
});

// What the table derives, pinned: an edit of the table that changes which paths a thread's snapshot
// leaves out, which writes count as the install changing, or what a run's caches and environment
// are, fails here first.
test("the paths and values derived from the table: threads' patterns, dev caches, DEV_ENV", async () => {
  const { CACHE_IN_NODE_MODULES, SNAPSHOT_SKIP, WRITTEN_DIRS } = await import('../../src/node-runtime/threads.ts');
  const { DEV_CACHE_DIRS } = await import('../../src/adapters/node/dev-cache.ts');
  const { DEV_ENV } = await import('../../src/adapters/node/scripts.ts');
  const inNodeModulesCache = ['/app/node_modules/.vite/deps/a.js', '/app/node_modules/.cache/x', '/app/node_modules/.tmp/y', '/app/node_modules/.astro/z', '/app/node_modules/.svelte-kit/w', '/app/node_modules/.vite-temp/v'];
  const notInNodeModulesCache = ['/app/node_modules/react/index.js', '/app/node_modules/.bin/vite', '/app/node_modules/.next/x', '/app/.vite/x'];
  for (const p of inNodeModulesCache) assert.ok(CACHE_IN_NODE_MODULES.test(p), p);
  for (const p of notInNodeModulesCache) assert.ok(!CACHE_IN_NODE_MODULES.test(p), p);
  const skipped = ['/app/node_modules', '/app/node_modules/x/y.js', '/app/.git/HEAD', '/app/.next/server/a.js', '/app/.angular/cache/x', '/app/.nuxt/x', '/app/.output/x', '/app/.svelte-kit/x', '/app/.astro/x', '/app/.vinxi/x', '/app/.turbo/x', '/app/.cache/x', '/app/client/.next'];
  const kept = ['/app/src/next.js', '/app/.nextx/a', '/app/.vite/x', '/app/node_modulesx/a', '/app/.github/workflows/ci.yml', '/app/package.json'];
  for (const p of skipped) assert.ok(SNAPSHOT_SKIP.test(p), p);
  for (const p of kept) assert.ok(!SNAPSHOT_SKIP.test(p), p);
  const written = ['/app/node_modules/.vite/deps/a.js', '/app/node_modules/.cache', '/app/node_modules/.tmp/a', '/app/.next/cache/x', '/app/.angular/cache', '/app/.nuxt/a', '/app/.output/a', '/app/.svelte-kit/a', '/app/.astro/a', '/app/.vinxi/a', '/app/.turbo/a', '/app/.cache/a'];
  const notWritten = ['/app/node_modules/react/index.js', '/app/node_modules/.vite-temp/a', '/app/node_modules', '/app/.git/HEAD', '/app/src/a.ts'];
  for (const p of written) assert.ok(WRITTEN_DIRS.test(p), p);
  for (const p of notWritten) assert.ok(!WRITTEN_DIRS.test(p), p);
  assert.deepEqual([...DEV_CACHE_DIRS].sort(), ['.angular/cache', 'node_modules/.cache/jiti', 'node_modules/.cache/vite', 'node_modules/.vite']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(DEV_ENV).sort(([a], [b]) => a.localeCompare(b))),
    { ASTRO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NEXT_TELEMETRY_DISABLED: '1', NG_CLI_ANALYTICS: 'false', NO_UPDATE_NOTIFIER: '1', NUXT_TELEMETRY_DISABLED: '1' },
  );
});

test("the Docker reference's probe names the frameworks it starts, from the table", async () => {
  const { dockerReference } = await import('../../src/reference/docker.ts');
  const run = dockerReference()();
  const verdict = run.probe({ name: 'x', path: '/x', files: {}, packageJson: { scripts: { dev: 'astro dev' } }, framework: 'astro' } as unknown as Parameters<typeof run.probe>[0]);
  assert.deepEqual(verdict, { verdict: 'unsupported', reason: 'the Docker reference runs Next.js, Angular and Vite dev servers, not "astro"' });
});
