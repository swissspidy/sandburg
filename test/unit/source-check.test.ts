/** The project's sources checked without running them (src/source-check.ts): syntax errors and undeclared imports. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources, describeFinding } from '../../src/source-check.ts';

const pkg = (deps: Record<string, string> = {}, extra: object = {}) => JSON.stringify({ name: 'app', dependencies: deps, ...extra });
const check = async (files: Record<string, string>) => (await checkSources(files)).map(describeFinding);

test('a syntax error is reported at its file, line and column; the rest of the project is still checked', async () => {
  const findings = await check({
    'package.json': pkg({ react: '^19.0.0' }),
    'src/App.tsx': "import React from 'react';\n\nconst broken = ;\nexport default function App() {\n  return <p>hi</p>;\n}\n",
    'src/util.ts': "import dayjs from 'dayjs';\nexport const today = dayjs();\n",
  });
  assert.deepEqual(findings, ['src/App.tsx:3:16: Unexpected ";"', 'imports undeclared package "dayjs" (src/util.ts:1)']);
});

test("an import counts only when it reaches the dev server: not a type's, nor one TypeScript elides, nor import() or require()", async () => {
  const findings = await check({
    'package.json': pkg(),
    'src/a.ts': "import type { Z } from 'zod';\nimport { type Y } from 'yup';\nimport unused from 'left-pad';\nexport const a: Z | Y = 1 as never;\n",
    'src/b.js': "export const load = () => import('optional-thing');\nexport const req = () => require('other-thing');\n",
    'src/c.ts': "import fs from 'node:fs';\nimport path from 'path';\nimport x from 'virtual:pwa-register';\nimport y from 'astro:content';\nimport z from '#imports';\nimport w from '~/utils';\nimport v from '$lib/v';\nimport u from '@/u';\nimport t from 'https://esm.sh/t';\nimport 'server-only';\nexport default [fs, path, x, y, z, w, v, u, t];\n",
  });
  assert.deepEqual(findings, []);
});

test("what a project declares: each package.json from the file's directory up, workspace packages, tsconfig paths, import maps, build-tool aliases", async () => {
  const findings = await check({
    'package.json': pkg({ react: '^19.0.0' }, { workspaces: ['packages/*'] }),
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', dependencies: { clsx: '^2.0.0' } }),
    'packages/ui/src/index.ts': "import clsx from 'clsx';\nimport React from 'react';\nexport default [clsx, React];\n",
    'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: {} }),
    'packages/web/src/main.ts': "import ui from '@acme/ui';\nimport clsx from 'clsx';\nimport A from '@components/button';\nimport B from 'shared/b';\nexport default [ui, clsx, A, B];\n",
    'packages/web/tsconfig.json': '{\n  // comments, as tsconfig.json has them\n  "compilerOptions": { "paths": { "shared/*": ["../shared/*"], }, },\n}\n',
    'packages/web/vite.config.ts': "export default { resolve: { alias: { '@components': '/src/components' } } };\n",
    'site/index.html': '<script type="importmap">{ "imports": { "lit": "https://esm.sh/lit", "lit/": "https://esm.sh/lit/" } }</script>',
    'site/main.js': "import { html } from 'lit';\nimport { map } from 'lit/directives/map.js';\nexport default [html, map];\n",
  });
  // clsx is declared by packages/ui, not by packages/web or the root.
  assert.deepEqual(findings, ['imports undeclared package "clsx" (packages/web/src/main.ts:2)']);
});

test("components are checked by their scripts, each a module, at the file's own lines: Vue's two blocks, Svelte's, Astro's frontmatter (its return too) and scripts", async () => {
  const findings = await check({
    'package.json': pkg({ vue: '^3.5.0', svelte: '^5.0.0', astro: '^5.0.0' }),
    'src/A.vue': "<script>\nimport { ref } from 'vue';\nexport default { name: 'A' };\n</script>\n<script setup lang=\"ts\">\nimport { ref } from 'vue';\nimport dayjs from 'dayjs';\nconst n = ref(dayjs());\n</script>\n<template><p>{{ n }}</p></template>\n",
    'src/B.svelte': "<script lang=\"ts\">\n  let { a }: { a: number } = $props();\n  const broken = ;\n</script>\n<p>{a}</p>\n",
    'src/C.svelte': '<script>\n  export let a;\n  $: b = a * 2;\n</script>\n<p>{b}</p>\n',
    'src/pages/index.astro': "---\nimport Layout from '../Layout.astro';\nimport { getCollection } from 'astro:content';\nconst posts = await getCollection('blog');\nif (!posts.length) return Astro.redirect('/empty');\n---\n<Layout><p>{posts.length}</p></Layout>\n<script>\n  import confetti from 'canvas-confetti';\n  confetti();\n</script>\n<script is:inline>\n  import x from 'not-processed';\n</script>\n<script type=\"application/ld+json\">{ \"@type\": \"x\" }</script>\n",
  });
  assert.deepEqual(findings, ['imports undeclared package "dayjs" (src/A.vue:7)', 'src/B.svelte:3:18: Unexpected ";"', 'imports undeclared package "canvas-confetti" (src/pages/index.astro:9)']);
});

test("tests, stories, type declarations, generated and built files, and dependencies are not the app's sources", async () => {
  const findings = await check({
    'package.json': pkg(),
    'src/App.test.ts': "import { test } from 'vitest';\nconst broken = ;\n",
    'src/Button.stories.tsx': "import type { Meta } from '@storybook/react';\nimport x from 'storybook-thing';\nexport default x;\n",
    'src/env.d.ts': "declare module 'thing' { const x: number; export default x; }\nimport y from 'types-only';\n",
    'tests/e2e.ts': "import { chromium } from 'playwright';\nexport default chromium;\n",
    '.nuxt/app.mjs': 'const broken = ;\n',
    'dist/main.js': "import x from 'bundled';\nexport default x;\n",
    'public/sw.js': "import x from 'workbox-sw';\nexport default x;\n",
    'node_modules/dep/index.js': 'const broken = ;\n',
  });
  assert.deepEqual(findings, []);
});
