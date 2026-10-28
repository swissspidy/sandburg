/** The project's sources checked without running them (src/source-check.ts): syntax errors and undeclared imports in the app's files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources, checkSourcesHere, describeFinding } from '../../src/source-check.ts';

const pkg = (deps: Record<string, string> = {}, extra: object = {}) => JSON.stringify({ name: 'app', dependencies: deps, ...extra });
/** A Vite app's page, whose script is the app's entry. */
const page = (src = '/src/main.ts') => `<!doctype html>\n<div id="app"></div>\n<script type="module" src="${src}"></script>\n`;
const check = async (files: Record<string, string>, app?: string) => (await checkSourcesHere(files, { app })).map(describeFinding);

test("a syntax error is reported at its file, line and column, and an undeclared import at its line, in the app's files", async () => {
  const findings = await check({
    'package.json': pkg({ react: '^19.0.0' }),
    'index.html': page('/src/main.tsx'),
    'src/main.tsx': "import App from './App';\nimport { today } from './util.js';\nexport default [App, today];\n",
    'src/App.tsx': "import React from 'react';\n\nconst broken = ;\nexport default function App() {\n  return <p>hi</p>;\n}\n",
    'src/util.ts': "import dayjs from 'dayjs';\nexport const today = dayjs();\n",
  });
  assert.deepEqual(findings, ['src/App.tsx:3:16: Unexpected ";"', 'imports undeclared package "dayjs" (src/util.ts:1)']);
});

test("only the app's files count: not a script, an example, a test's setup, or a file nothing imports", async () => {
  const files = {
    'package.json': pkg({}, { scripts: { dev: 'node server.js', seed: 'tsx scripts/seed.ts' } }),
    'server.js': "import { createServer } from 'node:http';\nimport './lib/routes.js';\ncreateServer().listen(3000);\n",
    'lib/routes.js': "import lodash from 'lodash';\nexport default lodash;\n",
    // The reviewer's case: a seed script importing an undeclared @faker-js/faker.
    'scripts/seed.ts': "import { faker } from '@faker-js/faker';\nconsole.log(faker.person.fullName());\n",
    'examples/demo.ts': 'const broken = ;\n',
    'src/test-setup.ts': "import 'zone.js/testing';\nimport x from 'zone.js';\nexport default x;\n",
    'src/setupTests.ts': "import '@testing-library/jest-dom';\n",
    'vitest.setup.ts': "import { expect } from 'vitest';\nexport default expect;\n",
    'src/unused.ts': "import dayjs from 'dayjs';\nexport default dayjs;\n",
  };
  // The dev script's server and what it imports are the app's.
  assert.deepEqual(await check(files), ['imports undeclared package "lodash" (lib/routes.js:1)']);
});

test("an import counts only when it reaches the dev server: not a type's, nor one TypeScript elides, nor import() or require(), nor an asset or an alias", async () => {
  const findings = await check({
    'package.json': pkg(),
    'index.html': page(),
    'src/main.ts': "import './a';\nimport './b.js';\nimport './c';\nexport const load = () => import('./lazy');\n",
    'src/a.ts': "import type { Z } from 'zod';\nimport { type Y } from 'yup';\nimport unused from 'left-pad';\nexport const a: Z | Y = 1 as never;\n",
    'src/b.js': "export const load = () => import('optional-thing');\nexport const req = () => require('other-thing');\n",
    'src/c.ts':
      "import fs from 'node:fs';\nimport path from 'path';\nimport x from 'virtual:pwa-register';\nimport y from 'astro:content';\nimport z from '#imports';\nimport w from '~/utils';\nimport v from '$lib/v';\nimport u from '@/u';\nimport t from 'https://esm.sh/t';\nimport 'server-only';\n" +
      // antfu/vitesse's virtual stylesheet, nuxt/movies' reset: assets, which a bundler plugin resolves.
      "import 'uno.css';\nimport '@unocss/reset/tailwind.css';\nimport raw from 'some-pkg/file.txt?raw';\nexport default [fs, path, x, y, z, w, v, u, t, raw];\n",
    // Reached by a dynamic import: its own static imports count.
    'src/lazy.ts': "import dayjs from 'dayjs';\nexport default dayjs;\n",
  });
  assert.deepEqual(findings, ['imports undeclared package "dayjs" (src/lazy.ts:1)']);
});

test("baseUrl's directories are the project's (vercel/commerce: `components/…` and `lib/…` from the root)", async () => {
  const findings = await check({
    'package.json': pkg({ next: '^15.0.0', react: '^19.0.0' }),
    'next.config.ts': 'export default {};\n',
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "jsx": "preserve" } }',
    'app/page.tsx': "import { Grid } from 'components/grid';\nimport { getMenu } from 'lib/shopify';\nimport clsx from 'clsx';\nexport default function Page() { return <Grid items={getMenu()} className={clsx('a')} />; }\n",
    'components/grid/index.tsx': "export function Grid(props: object) { return <div {...props} />; }\n",
    'lib/shopify/index.ts': 'export const getMenu = () => [];\n',
  });
  assert.deepEqual(findings, ['imports undeclared package "clsx" (app/page.tsx:3)']);
});

test("what a project declares: each package.json from the file's directory up, workspace packages, tsconfig paths, import maps, build-tool aliases", async () => {
  const findings = await check(
    {
      'package.json': pkg({ react: '^19.0.0' }, { workspaces: ['packages/*'] }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': { import: './src/index.ts' } }, dependencies: { clsx: '^2.0.0' } }),
      'packages/ui/src/index.ts': "import clsx from 'clsx';\nimport React from 'react';\nimport x from 'only-in-ui';\nexport default [clsx, React, x];\n",
      'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: {} }),
      'packages/web/index.html': page(),
      'packages/web/src/main.ts': "import ui from '@acme/ui';\nimport clsx from 'clsx';\nimport A from '@components/button';\nimport B from 'shared/b';\nexport default [ui, clsx, A, B];\n",
      'packages/web/tsconfig.json': '{\n  // comments, as tsconfig.json has them\n  "compilerOptions": { "paths": { "shared/*": ["../shared/*"], }, },\n}\n',
      'packages/shared/b.ts': 'export default 1;\n',
      'packages/web/vite.config.ts': "export default { resolve: { alias: { '@components': '/src/components' } } };\n",
      'packages/web/src/components/button.ts': 'export default 1;\n',
    },
    'packages/web',
  );
  // clsx is declared by packages/ui, not by packages/web or the root; the workspace package is followed.
  assert.deepEqual(findings, ['imports undeclared package "only-in-ui" (packages/ui/src/index.ts:3)', 'imports undeclared package "clsx" (packages/web/src/main.ts:2)']);
  const site = await check({ 'index.html': '<script type="importmap">{ "imports": { "lit": "https://esm.sh/lit", "lit/": "https://esm.sh/lit/" } }</script>\n<script type="module" src="main.js"></script>', 'main.js': "import { html } from 'lit';\nimport { map } from 'lit/directives/map.js';\nexport default [html, map];\n" });
  assert.deepEqual(site, []);
});

test('a package a lockfile lists as installed is not undeclared: hoisted by npm (elk: vue-router, h3) or yarn, listed by pnpm or bun; a peer of a workspace package', async () => {
  const app = (lockfile: Record<string, string>) => ({
    'package.json': pkg({ vue: '^3.5.0' }),
    'index.html': page(),
    'src/main.ts': "import { createRouter } from 'vue-router';\nimport { defineEventHandler } from 'h3';\nimport dayjs from 'dayjs';\nexport default [createRouter, defineEventHandler, dayjs];\n",
    ...lockfile,
  });
  const npm = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/vue-router': {}, 'node_modules/h3': {}, 'node_modules/nuxt/node_modules/dayjs': {} } });
  // dayjs is only nested under another package: not resolvable from the app.
  assert.deepEqual(await check(app({ 'package-lock.json': npm })), ['imports undeclared package "dayjs" (src/main.ts:3)']);
  const yarn = '# yarn lockfile v1\n\n"vue-router@^4.0.0", vue-router@^4.1.0:\n  version "4.4.0"\n\nh3@^1.0.0:\n  version "1.13.0"\n';
  assert.deepEqual(await check(app({ 'yarn.lock': yarn })), ['imports undeclared package "dayjs" (src/main.ts:3)']);
  const pnpm = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      vue:\n        specifier: ^3.5.0\n\npackages:\n\n  vue-router@4.4.0:\n    resolution: {integrity: x}\n\n  h3@1.13.0:\n    resolution: {integrity: x}\n";
  assert.deepEqual(await check(app({ 'pnpm-lock.yaml': pnpm })), ['imports undeclared package "dayjs" (src/main.ts:3)']);
  const bun = '{\n  "lockfileVersion": 1,\n  "packages": {\n    "vue-router": ["vue-router@4.4.0", "", {}, "sha"],\n    "h3": ["h3@1.13.0", "", {}, "sha"],\n  },\n}\n';
  assert.deepEqual(await check(app({ 'bun.lock': bun })), ['imports undeclared package "dayjs" (src/main.ts:3)']);
  // A monorepo whose app imports react, declared only as packages/ui's peer: installed at the root.
  const peer = await check(
    {
      'package.json': pkg({}, { workspaces: ['apps/*', 'packages/*'] }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/react': {}, 'apps/web/node_modules/zod': {} } }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', peerDependencies: { react: '*' } }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/web/src/main.tsx': "import React from 'react';\nimport { z } from 'zod';\nexport default [React, z];\n",
    },
    'apps/web',
  );
  assert.deepEqual(peer, []);
});

test("components are checked by their scripts, each a module, at the file's own lines, whatever their start tags hold", async () => {
  const findings = await check({
    'package.json': pkg({ vue: '^3.5.0', svelte: '^5.0.0', astro: '^5.0.0' }),
    'index.html': page(),
    'src/main.ts': "import A from './A.vue';\nimport G from './G.vue';\nimport B from './B.svelte';\nimport C from './C.svelte';\nimport D from './D.svelte';\nexport default [A, G, B, C, D];\n",
    // Two blocks (each a module: `ref` twice is no redeclaration); a template-only import is still an import.
    'src/A.vue': "<script>\nimport { ref } from 'vue';\nexport default { name: 'A' };\n</script>\n<script setup lang=\"ts\">\nimport { ref } from 'vue';\nimport dayjs from 'dayjs';\nimport Child from './Child.vue';\nconst n = ref(dayjs());\n</script>\n<template><Child>{{ n }}</Child></template>\n",
    'src/Child.vue': '<script setup lang="ts">\nconst broken = ;\n</script>\n',
    // `>` in attributes: Vue's generic, Svelte's generics.
    'src/G.vue': '<script setup lang="ts" generic="T extends Record<string, unknown>, F extends (x: T) => void">\ndefineProps<{ items: T[]; f: F }>();\n</script>\n<template><p /></template>\n',
    'src/B.svelte': "<script lang=\"ts\" generics=\"T extends Array<string>\">\n  let { a }: { a: T } = $props();\n</script>\n<p>{a}</p>\n",
    'src/C.svelte': '<script>\n  export let a;\n  $: b = a * 2;\n</script>\n<p>{b}</p>\n',
    'src/D.svelte': '<script lang="ts">\n  const broken = ;\n</script>\n',
    'src/pages/index.astro':
      "---\nimport Layout from '../Layout.astro';\nimport { getCollection } from 'astro:content';\nconst posts = await getCollection('blog');\nif (!posts.length) return Astro.redirect('/empty');\nconst a = posts.length;\n---\n<Layout><p>{a}</p></Layout>\n" +
      '<script define:vars={{ b: a > 0 }}>\n  console.log(b);\n</script>\n' +
      "<script>\n  import confetti from 'canvas-confetti';\n  confetti();\n</script>\n<script is:inline>\n  import x from 'not-processed';\n</script>\n<script type=\"application/ld+json\">{ \"@type\": \"x\" }</script>\n",
    // An empty frontmatter, and `---` later in the HTML; a self-closing script with set:html, then HTML.
    'src/Layout.astro': '---\n---\n<main><slot /></main>\n<script set:html={code} />\n<p>a > b</p>\n<hr />\n---\n<p>after</p>\n',
  });
  assert.deepEqual(findings, ['imports undeclared package "dayjs" (src/A.vue:7)', 'src/Child.vue:2:16: Unexpected ";"', 'src/D.svelte:2:18: Unexpected ";"', 'imports undeclared package "canvas-confetti" (src/pages/index.astro:13)']);
});

test("legacy decorators parse with the project's tsconfig (Angular's and Nest's parameter decorators, Lit's `declare` fields), through `extends`", async () => {
  const sources = {
    'src/main.ts': "import './service';\nimport './element';\n",
    'src/service.ts': "import { Injectable, Inject } from '@nestjs/common';\n@Injectable()\nexport class S {\n  constructor(@Inject('T') private t: string) {}\n}\n",
    'src/element.ts': "import { LitElement } from 'lit';\nimport { property } from 'lit/decorators.js';\nexport class E extends LitElement {\n  @property() declare foo: string;\n}\n",
  };
  const deps = pkg({ '@nestjs/common': '^11.0.0', lit: '^3.0.0' });
  assert.deepEqual(await check({ 'package.json': deps, 'tsconfig.base.json': '{ "compilerOptions": { "experimentalDecorators": true } }', 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }', ...sources }), []);
  // Without the setting, they are what esbuild says they are.
  assert.deepEqual(await check({ 'package.json': deps, ...sources }), ['src/element.ts:4:3: Decorators are not valid here', 'src/service.ts:4:15: Parameter decorators only work when experimental decorators are enabled']);
});

test("a classic script's sloppy-mode code is no error; a module's is", async () => {
  const findings = await check({
    'index.html': '<script src="js/legacy.js"></script>\n<script type="module" src="js/app.js"></script>\n',
    'js/legacy.js': 'var o = { a: 1 };\nwith (o) { a = 2; }\n',
    'js/app.js': "import './util.js';\nvar o = { a: 1 };\nwith (o) { a = 2; }\n",
    'js/util.js': 'export const u = 1;\n',
  });
  assert.deepEqual(findings, ['js/app.js:3:1: With statements cannot be used in an ECMAScript module']);
});

test("tests, stories, type declarations, generated and built files, and dependencies are not the app's sources", async () => {
  const findings = await check({
    'package.json': pkg(),
    'index.html': page(),
    'src/main.ts': "import './App.test';\nimport './Button.stories';\nexport {};\n",
    'src/App.test.ts': "import { test } from 'vitest';\nconst broken = ;\n",
    'src/Button.stories.tsx': "import x from 'storybook-thing';\nexport default x;\n",
    'src/env.d.ts': "declare module 'thing' { const x: number; export default x; }\nimport y from 'types-only';\n",
    'tests/e2e.ts': "import { chromium } from 'playwright';\nexport default chromium;\n",
    '.nuxt/app.mjs': 'const broken = ;\n',
    'dist/main.js': "import x from 'bundled';\nexport default x;\n",
    'public/sw.js': "import x from 'workbox-sw';\nexport default x;\n",
    'node_modules/dep/index.js': 'const broken = ;\n',
  });
  assert.deepEqual(findings, []);
});

test('the check runs on a thread of its own, with a time budget: the same findings, or none once the budget is spent', async () => {
  const files = { 'package.json': pkg(), 'index.html': page(), 'src/main.ts': 'const broken = ;\n' };
  assert.deepEqual(await checkSources(files), await checkSourcesHere(files));
  const start = performance.now();
  assert.deepEqual(await checkSources(files, {}, 1), []);
  assert.ok(performance.now() - start < 1_000);
});

test("pathological files cost little: an unclosed script per 8 bytes, a page of import maps, oversized files are not read", async () => {
  const start = performance.now();
  const findings = await check({
    'package.json': pkg(),
    'index.html': page() + '<script type=importmap>'.repeat(20_000),
    'src/main.ts': "import A from './A.vue';\nexport default A;\n",
    'src/A.vue': '<script>'.repeat(65_000),
    'src/B.svelte': `<script ${'a="'.repeat(100_000)}`,
    'src/C.astro': `---\n${'-'.repeat(400_000)}`,
  });
  // The unclosed script runs to the end of the file, where esbuild says so.
  assert.deepEqual(findings, ['src/A.vue:1:520001: Unexpected end of file before a closing "script" tag']);
  assert.ok(performance.now() - start < 2_000, `took ${Math.round(performance.now() - start)} ms`);
  // On a thread of its own, a page over the size cap is not sent.
  const big = { 'package.json': pkg(), 'index.html': page('/src/entry.ts') + `<!-- ${'x'.repeat(600 * 1024)} -->`, 'src/entry.ts': 'const broken = ;\n' };
  assert.deepEqual(await checkSourcesHere(big), [{ rule: 'compile-error', file: 'src/entry.ts', line: 1, column: 16, message: 'Unexpected ";"' }]);
  assert.deepEqual(await checkSources(big), []);
});
