/**
 * Scaffolds for the frameworks added to the corpus in fidelity study v7 (generate.ts picks each
 * app's stack, features and fault; this file writes its files). Each follows its framework's own
 * starter, as in fixtures/, with the framework's packages pinned on the day the corpus grew
 * (2026-10-28), as the v1–v6 apps pin Next.js and React.
 */
import { transformSync } from 'esbuild';
import { FEATURES } from './features.ts';
import { KITS, vanillaDates, type CoreFeature, type Kit } from './components.ts';
import type { AppMeta } from './generate.ts';

export type Stack = 'sveltekit' | 'angular' | 'nuxt' | 'astro' | 'solid-start' | 'react-router' | 'vue-vite' | 'svelte-vite' | 'lit-vite' | 'vue-express' | 'react-express' | 'static';

/** The package the undeclared-import fault imports: none of the stacks installs it. */
export const UNDECLARED = 'dayjs';

const DATA = JSON.stringify({ products: [{ id: 1, name: 'Lamp', price: 25 }, { id: 2, name: 'Chair', price: 80 }, { id: 3, name: 'Desk', price: 150 }] }, null, 2);

const VERSIONS = {
  vue: '3.5.44',
  svelte: '5.57.3',
  kit: '3.1.0',
  nuxt: '4.6.3',
  astro: '7.4.2',
  solidStart: '2.1.0',
  solid: '1.9.17',
  reactRouter: '8.5.1',
  react: '19.3.1',
  angular: '22.2.3',
  angularCli: '22.2.4',
  lit: '3.3.3',
};

const STYLE = `body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n}\n\nmain {\n  max-width: 40rem;\n  margin: 2rem auto;\n  padding: 0 1rem;\n}\n\nsection {\n  margin-bottom: 1.5rem;\n}\n`;

/** The crash fault: reading a setting that was never defined, while the page renders. */
const CRASH_TS = `const settings = (globalThis as any).__APP_SETTINGS__;\nconst theme = settings.theme;\n`;

export function componentName(feature: string): string {
  return feature.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('') + 'Feature';
}

export function pkg(name: string, scripts: Record<string, string>, deps: Record<string, string>, devDeps: Record<string, string>, module: boolean): string {
  return (
    JSON.stringify(
      { name: `corpus-${name}`, private: true, version: '0.0.0', ...(module ? { type: 'module' } : {}), scripts, dependencies: sortKeys(deps), devDependencies: sortKeys(devDeps) },
      null,
      2,
    ) + '\n'
  );
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

const indent = (lines: string[], n: number) => lines.map((l) => ' '.repeat(n) + l).join('\n');
const html = (title: string, body: string, head = '') =>
  `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title}</title>\n${head}  </head>\n  <body>\n${body}\n  </body>\n</html>\n`;

/** Dependencies the features import, and the bad-version fault's. */
function featureDeps(meta: AppMeta, react: boolean): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const f of meta.features) {
    if (react) Object.assign(deps, FEATURES[f].deps);
    else if (f === 'dates') deps['date-fns'] = '^4.1.0';
  }
  if (meta.fault === 'bad-version') deps[react ? 'react-confetti' : 'canvas-confetti'] = '^99.0.0';
  return deps;
}

/** Seeds the syntax, type-error and undeclared-import faults into a component's source. */
function seedFault(code: string, fault: AppMeta['fault']): string {
  const snippet =
    fault === 'syntax'
      ? 'const broken = ;\n'
      : fault === 'type-error'
        ? "const budget: number = 'unlimited';\nvoid budget;\n"
        : fault === 'undeclared-import'
          ? `import dayjs from '${UNDECLARED}';\nconst today = dayjs().format('YYYY-MM-DD');\nvoid today;\n`
          : null;
  if (!snippet) return code;
  const script = /<script[^>]*>\n/.exec(code);
  // In a single-file component, at the top of its script; in a module, before what it exports.
  if (script) {
    const at = script.index + script[0].length;
    const pad = /^\s*/.exec(code.slice(at))![0];
    return code.slice(0, at) + snippet.split('\n').map((l) => (l ? pad + l : l)).join('\n') + '\n' + code.slice(at);
  }
  const at = /^(export default function|export function mount|@Component|@customElement)/m.exec(code)!.index;
  return code.slice(0, at) + snippet + '\n' + code.slice(at);
}

interface Component {
  name: string;
  file: string;
  feature: string;
}

/** Writes each feature's component with `source(feature, bug)`, and seeds the fault into the first. */
function components(meta: AppMeta, files: Record<string, string>, path: (f: string) => string, source: (f: string, bug: boolean) => string): Component[] {
  const list = meta.features.map((f) => ({ name: componentName(f), file: path(f), feature: f }));
  for (const c of list) files[c.file] = source(c.feature, meta.buggyFeature === c.feature && !serverBug(meta));
  files[list[0].file] = seedFault(files[list[0].file], meta.fault);
  return list;
}

/** The full-stack apps' fetch bug is in the server's query, not the client. */
const serverBug = (meta: AppMeta) => (meta.target === 'vue-express' || meta.target === 'react-express') && meta.buggyFeature === 'fetch';

const kit = (k: Kit, source: string) => (f: string, bug: boolean) => KITS[k][f as CoreFeature](bug, source);
const reactSource = (f: string, bug: boolean) => FEATURES[f].react!(bug);
const vanillaSource = (source: string) => (f: string, bug: boolean) => (f === 'dates' ? vanillaDates(bug) : FEATURES[f].vanilla!(bug).replace("'/data/products.json'", `'${source}'`));

export function stackFiles(meta: AppMeta, title: string): Record<string, string> {
  const stack = meta.target as Stack;
  switch (stack) {
    case 'vue-vite':
    case 'vue-express':
      return vueApp(meta, title, stack);
    case 'nuxt':
      return nuxtApp(meta, title);
    case 'svelte-vite':
      return svelteApp(meta, title);
    case 'sveltekit':
      return svelteKitApp(meta, title);
    case 'solid-start':
      return solidStartApp(meta, title);
    case 'react-router':
      return reactRouterApp(meta, title);
    case 'react-express':
      return reactExpressApp(meta, title);
    case 'angular':
      return angularApp(meta, title);
    case 'lit-vite':
      return litApp(meta, title);
    case 'astro':
      return astroApp(meta, title);
    case 'static':
      return staticApp(meta, title);
  }
}

function vueApp(meta: AppMeta, title: string, stack: 'vue-vite' | 'vue-express'): Record<string, string> {
  const files: Record<string, string> = {};
  const express = stack === 'vue-express';
  const source = express ? '/api/products' : '/data/products.json';
  const list = components(meta, files, (f) => `src/components/${componentName(f)}.vue`, kit('vue', source));
  const crash = meta.fault === 'crash';
  files['src/App.vue'] = `<script setup lang="ts">
${list.map((c) => `import ${c.name} from './components/${c.name}.vue';`).join('\n')}
${crash ? `\n${CRASH_TS}` : ''}</script>

<template>
  <main${crash ? ' :data-theme="theme"' : ''}>
    <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ` source="${source}"` : ''} />`), 4)}
  </main>
</template>
`;
  files['src/main.ts'] = `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\n\ncreateApp(App).mount('#app');\n`;
  files['src/style.css'] = STYLE;
  files['src/env.d.ts'] = `/// <reference types="vite/client" />\n`;
  files['index.html'] = html(title, `    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>`);
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'preserve', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/**/*.ts', 'src/**/*.vue'] }, null, 2) + '\n';
  const deps = { vue: VERSIONS.vue, ...featureDeps(meta, false) };
  const devDeps: Record<string, string> = { '@vitejs/plugin-vue': '^6.0.10', typescript: '~6.0.2', vite: '^8.3.5', 'vue-tsc': '^3.1.0' };
  if (express) return Object.assign(files, expressServer(meta, title, deps, devDeps, `import vue from '@vitejs/plugin-vue';`, 'vue()'));
  files['package.json'] = pkg(meta.id, { dev: 'vite', build: 'vue-tsc -b && vite build', preview: 'vite preview' }, deps, devDeps, true);
  files['vite.config.ts'] = `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n});\n`;
  if (meta.features.includes('fetch')) files['public/data/products.json'] = DATA + '\n';
  return files;
}

function nuxtApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `app/components/${componentName(f)}.vue`, kit('vue', '/api/products'));
  const crash = meta.fault === 'crash';
  files['app/app.vue'] = `<template>\n  <NuxtPage />\n</template>\n`;
  files['app/pages/index.vue'] = `<script setup lang="ts">
useHead({ title: '${title}' });
${crash ? `\n${CRASH_TS}` : ''}</script>

<template>
  <main${crash ? ' :data-theme="theme"' : ''}>
    <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ' source="/api/products"' : ''} />`), 4)}
  </main>
</template>
`;
  files['app/assets/css/main.css'] = STYLE;
  if (meta.features.includes('fetch')) files['server/api/products.ts'] = `const DATA = ${DATA};\n\nexport default defineEventHandler(() => DATA);\n`;
  files['nuxt.config.ts'] = `// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n  devtools: { enabled: false },\n  css: ['~/assets/css/main.css'],\n});\n`;
  files['tsconfig.json'] = JSON.stringify({ files: [], references: ['app', 'server', 'shared', 'node'].map((p) => ({ path: `./.nuxt/tsconfig.${p}.json` })) }, null, 2) + '\n';
  files['package.json'] = pkg(
    meta.id,
    { build: 'nuxt build', dev: 'nuxt dev', generate: 'nuxt generate', preview: 'nuxt preview', postinstall: 'nuxt prepare' },
    { nuxt: VERSIONS.nuxt, vue: VERSIONS.vue, 'vue-router': '^5.4.0', ...featureDeps(meta, false) },
    {},
    true,
  );
  return files;
}

const SVELTE_DEV = { '@sveltejs/vite-plugin-svelte': '^7.3.1', svelte: VERSIONS.svelte, 'svelte-check': '^4.7.6', typescript: '~6.0.2', vite: '^8.3.5' };

function svelteApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/lib/${componentName(f)}.svelte`, kit('svelte', '/data/products.json'));
  const crash = meta.fault === 'crash';
  files['src/App.svelte'] = `<script lang="ts">
${list.map((c) => `  import ${c.name} from './lib/${c.name}.svelte';`).join('\n')}
${crash ? `\n${indent(CRASH_TS.trim().split('\n'), 2)}\n` : ''}</script>

<main${crash ? ' data-theme={theme}' : ''}>
  <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ' source="/data/products.json"' : ''} />`), 2)}
</main>
`;
  files['src/main.ts'] = `import { mount } from 'svelte';\nimport './app.css';\nimport App from './App.svelte';\n\nconst app = mount(App, {\n  target: document.getElementById('app')!,\n});\n\nexport default app;\n`;
  files['src/app.css'] = STYLE;
  files['index.html'] = html(title, `    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>`);
  files['svelte.config.js'] = `/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */\nexport default {};\n`;
  files['vite.config.ts'] = `import { svelte } from '@sveltejs/vite-plugin-svelte';\nimport { defineConfig } from 'vite';\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [svelte()],\n});\n`;
  files['tsconfig.json'] = JSON.stringify({ extends: '@tsconfig/svelte/tsconfig.json', compilerOptions: { target: 'es2023', module: 'esnext', types: ['svelte', 'vite/client'], noEmit: true, allowJs: true, checkJs: true, moduleDetection: 'force' }, include: ['src/**/*.ts', 'src/**/*.js', 'src/**/*.svelte'] }, null, 2) + '\n';
  if (meta.features.includes('fetch')) files['public/data/products.json'] = DATA + '\n';
  files['package.json'] = pkg(meta.id, { dev: 'vite', build: 'vite build', preview: 'vite preview', check: 'svelte-check --tsconfig ./tsconfig.json' }, featureDeps(meta, false), { ...SVELTE_DEV, '@tsconfig/svelte': '^5.0.8' }, true);
  return files;
}

function svelteKitApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/lib/components/${componentName(f)}.svelte`, kit('svelte', '/api/products'));
  const crash = meta.fault === 'crash';
  files['src/routes/+page.svelte'] = `<script lang="ts">
${list.map((c) => `  import ${c.name} from '#lib/components/${c.name}.svelte';`).join('\n')}
${crash ? `\n${indent(CRASH_TS.trim().split('\n'), 2)}\n` : ''}</script>

<svelte:head>
  <title>${title}</title>
</svelte:head>

<main${crash ? ' data-theme={theme}' : ''}>
  <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ' source="/api/products"' : ''} />`), 2)}
</main>
`;
  files['src/routes/+layout.svelte'] = `<script lang="ts">\n  import '../app.css';\n\n  let { children } = $props();\n</script>\n\n{@render children()}\n`;
  if (meta.features.includes('fetch')) files['src/routes/api/products/+server.ts'] = `import { json } from '@sveltejs/kit';\n\nconst DATA = ${DATA};\n\nexport function GET() {\n  return json(DATA);\n}\n`;
  files['src/app.css'] = STYLE;
  files['src/lib/index.ts'] = `// place files you want to import through the \`#lib\` import in this folder.\n`;
  files['src/app.d.ts'] = `// See https://svelte.dev/docs/kit/types#app.d.ts\n// for information about these interfaces\ndeclare global {\n  namespace App {\n    // interface Error {}\n    // interface Locals {}\n    // interface PageData {}\n    // interface PageState {}\n    // interface Platform {}\n  }\n}\n\nexport {};\n`;
  files['src/app.html'] = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    %sveltekit.head%\n  </head>\n  <body data-sveltekit-preload-data="hover">\n    <div style="display: contents">%sveltekit.body%</div>\n  </body>\n</html>\n`;
  files['vite.config.ts'] = `import adapter from '@sveltejs/adapter-auto';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [\n    sveltekit({\n      compilerOptions: {\n        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.\n        runes: ({ filename }) => (filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true),\n      },\n      adapter: adapter(),\n    }),\n  ],\n});\n`;
  files['tsconfig.json'] = JSON.stringify({ extends: '$app/tsconfig', compilerOptions: { rewriteRelativeImportExtensions: true, allowJs: true, checkJs: true, esModuleInterop: true, forceConsistentCasingInFileNames: true, resolveJsonModule: true, skipLibCheck: true, sourceMap: true, strict: true, moduleResolution: 'bundler' }, include: ['src', '*'], exclude: ['checks.spec.ts'] }, null, 2) + '\n';
  const json = JSON.parse(
    pkg(
      meta.id,
      { dev: 'vite dev', build: 'vite build', preview: 'vite preview', prepare: "svelte-kit sync || echo ''", check: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json' },
      featureDeps(meta, false),
      { ...SVELTE_DEV, '@sveltejs/adapter-auto': '^8.0.0', '@sveltejs/kit': VERSIONS.kit },
      true,
    ),
  );
  files['package.json'] = JSON.stringify({ ...json, imports: { '#lib': './src/lib/index.ts', '#lib/*': './src/lib/*' } }, null, 2) + '\n';
  return files;
}

function solidStartApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/components/${componentName(f)}.tsx`, kit('solid', '/api/products'));
  const crash = meta.fault === 'crash';
  files['src/routes/index.tsx'] = `import { Title } from '@solidjs/meta';
${list.map((c) => `import ${c.name} from '../components/${c.name}';`).join('\n')}

export default function Home() {
${crash ? indent(CRASH_TS.trim().split('\n'), 2) + '\n' : ''}  return (
    <main${crash ? ' data-theme={theme}' : ''}>
      <Title>${title}</Title>
      <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ' source="/api/products"' : ''} />`), 6)}
    </main>
  );
}
`;
  if (meta.features.includes('fetch')) files['src/routes/api/products.ts'] = `import { json } from '@solidjs/router';\n\nconst DATA = ${DATA};\n\nexport function GET() {\n  return json(DATA);\n}\n`;
  files['src/app.tsx'] = `import { MetaProvider, Title } from '@solidjs/meta';\nimport { Router } from '@solidjs/router';\nimport { FileRoutes } from '@solidjs/start/router';\nimport { Suspense } from 'solid-js';\nimport './app.css';\n\nexport default function App() {\n  return (\n    <Router\n      root={(props) => (\n        <MetaProvider>\n          <Title>${title}</Title>\n          <Suspense>{props.children}</Suspense>\n        </MetaProvider>\n      )}\n    >\n      <FileRoutes />\n    </Router>\n  );\n}\n`;
  files['src/app.css'] = STYLE;
  files['src/entry-client.tsx'] = `// @refresh reload\nimport { mount, StartClient } from '@solidjs/start/client';\n\nmount(() => <StartClient />, document.getElementById('app')!);\n`;
  files['src/entry-server.tsx'] = `// @refresh reload\nimport { createHandler, StartServer } from '@solidjs/start/server';\n\nexport default createHandler(() => (\n  <StartServer\n    document={({ assets, children, scripts }) => (\n      <html lang="en">\n        <head>\n          <meta charset="utf-8" />\n          <meta name="viewport" content="width=device-width, initial-scale=1" />\n          {assets}\n        </head>\n        <body>\n          <div id="app">{children}</div>\n          {scripts}\n        </body>\n      </html>\n    )}\n  />\n));\n`;
  files['vite.config.ts'] = `import { defineConfig } from 'vite';\nimport { solidStart } from '@solidjs/start/config';\n\nexport default defineConfig({\n  plugins: [solidStart()],\n});\n`;
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', allowSyntheticDefaultImports: true, esModuleInterop: true, jsx: 'preserve', jsxImportSource: 'solid-js', allowJs: true, strict: true, noEmit: true, types: ['vite/client', '@solidjs/start/env'], isolatedModules: true, paths: { '~/*': ['./src/*'] } } }, null, 2) + '\n';
  files['package.json'] = pkg(
    meta.id,
    { dev: 'vite dev', build: 'vite build', start: 'vite preview' },
    { '@solidjs/meta': '^0.29.4', '@solidjs/router': '^1.0.0', '@solidjs/start': VERSIONS.solidStart, 'solid-js': VERSIONS.solid, vite: '^8.3.5', ...featureDeps(meta, false) },
    {},
    true,
  );
  return files;
}

const REACT_TYPES = { '@types/react': '^19.2.0', '@types/react-dom': '^19.2.0', typescript: '~6.0.2' };

function reactRouterApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `app/components/${componentName(f)}.tsx`, reactSource);
  const crash = meta.fault === 'crash';
  files['app/routes/home.tsx'] = `${list.map((c) => `import ${c.name} from '../components/${c.name}';`).join('\n')}

export function meta() {
  return [{ title: '${title}' }];
}

export default function Home() {
${crash ? indent(CRASH_TS.trim().split('\n'), 2) + '\n' : ''}  return (
    <main${crash ? ' data-theme={theme}' : ''}>
      <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ' source="/api/products"' : ''} />`), 6)}
    </main>
  );
}
`;
  const fetch = meta.features.includes('fetch');
  if (fetch) files['app/routes/api.products.ts'] = `const DATA = ${DATA};\n\nexport function loader() {\n  return Response.json(DATA);\n}\n`;
  files['app/routes.ts'] = `import { type RouteConfig, index${fetch ? ', route' : ''} } from '@react-router/dev/routes';\n\nexport default [index('routes/home.tsx')${fetch ? ", route('api/products', 'routes/api.products.ts')" : ''}] satisfies RouteConfig;\n`;
  files['app/app.css'] = STYLE;
  files['app/root.tsx'] = `import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import type { Route } from './+types/root';
import './app.css';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details = error.status === 404 ? 'The requested page could not be found.' : error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
  }
  return (
    <main>
      <h1>{message}</h1>
      <p>{details}</p>
    </main>
  );
}
`;
  files['react-router.config.ts'] = `import type { Config } from '@react-router/dev/config';\n\nexport default {\n  ssr: true,\n} satisfies Config;\n`;
  files['vite.config.ts'] = `import { reactRouter } from '@react-router/dev/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [reactRouter()],\n});\n`;
  files['tsconfig.json'] = JSON.stringify({ include: ['**/*', '**/.server/**/*', '**/.client/**/*', '.react-router/types/**/*'], compilerOptions: { lib: ['DOM', 'DOM.Iterable', 'ES2022'], types: ['node', 'vite/client'], target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', jsx: 'react-jsx', rootDirs: ['.', './.react-router/types'], esModuleInterop: true, verbatimModuleSyntax: true, noEmit: true, resolveJsonModule: true, skipLibCheck: true, strict: true } }, null, 2) + '\n';
  const rr = VERSIONS.reactRouter;
  files['package.json'] = pkg(
    meta.id,
    { build: 'react-router build', dev: 'react-router dev', start: 'react-router-serve ./build/server/index.js', typecheck: 'react-router typegen && tsc' },
    { '@react-router/node': rr, '@react-router/serve': rr, isbot: '^5.1.31', react: VERSIONS.react, 'react-dom': VERSIONS.react, 'react-router': rr, ...featureDeps(meta, true) },
    { '@react-router/dev': rr, ...REACT_TYPES, vite: '^8.3.5' },
    true,
  );
  return files;
}

function reactExpressApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/components/${componentName(f)}.tsx`, reactSource);
  const crash = meta.fault === 'crash';
  files['src/App.tsx'] = `${list.map((c) => `import ${c.name} from './components/${c.name}';`).join('\n')}

export default function App() {
${crash ? indent(CRASH_TS.trim().split('\n'), 2) + '\n' : ''}  return (
    <main${crash ? ' data-theme={theme}' : ''}>
      <h1>${title}</h1>
${indent(list.map((c) => `<${c.name}${c.feature === 'fetch' ? ' source="/api/products"' : ''} />`), 6)}
    </main>
  );
}
`;
  files['src/main.tsx'] = `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`;
  files['src/index.css'] = STYLE;
  files['index.html'] = html(title, `    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>`);
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true }, include: ['src'] }, null, 2) + '\n';
  const deps = { react: VERSIONS.react, 'react-dom': VERSIONS.react, ...featureDeps(meta, true) };
  const devDeps = { '@vitejs/plugin-react': '^6.1.2', ...REACT_TYPES, vite: '^8.3.5' };
  return Object.assign(files, expressServer(meta, title, deps, devDeps, `import react from '@vitejs/plugin-react';`, 'react()'));
}

/** The full-stack apps' server: Express and SQLite (better-sqlite3), behind Vite's proxy, as in fixtures/vue-express-sqlite. */
function expressServer(meta: AppMeta, title: string, deps: Record<string, string>, devDeps: Record<string, string>, pluginImport: string, plugin: string): Record<string, string> {
  const files: Record<string, string> = {};
  files['package.json'] = pkg(
    meta.id,
    { dev: 'concurrently "npm:server" "npm:client"', server: 'node --watch server/index.js', client: 'vite', build: 'vite build' },
    { 'better-sqlite3': '^13.0.0', express: '^5.2.0', ...deps },
    { concurrently: '^10.0.0', ...devDeps },
    true,
  );
  files['vite.config.ts'] = `import { defineConfig } from 'vite';\n${pluginImport}\n\nexport default defineConfig({\n  plugins: [${plugin}],\n  server: {\n    proxy: {\n      '/api': 'http://localhost:3001',\n    },\n  },\n});\n`;
  files['server/db.js'] = `import Database from 'better-sqlite3';

const db = new Database('${title.toLowerCase().replace(' ', '-')}.db');
db.pragma('journal_mode = WAL');

db.exec(\`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL
  )
\`);

const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (count === 0) {
  const insert = db.prepare('INSERT INTO products (name, price) VALUES (@name, @price)');
  const seed = db.transaction((products) => {
    for (const product of products) insert.run(product);
  });
  seed([
    { name: 'Lamp', price: 25 },
    { name: 'Chair', price: 80 },
    { name: 'Desk', price: 150 },
  ]);
}

export default db;
`;
  files['server/index.js'] = `import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());

const listProducts = db.prepare('SELECT id, name, price FROM products ORDER BY price ${serverBug(meta) ? 'DESC' : 'ASC'}');

app.get('/api/products', (req, res) => {
  res.json({ products: listProducts.all() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(\`API listening on http://localhost:\${port}\`));
`;
  return files;
}

function angularApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/app/features/${f}.ts`, kit('angular', '/data/products.json'));
  const crash = meta.fault === 'crash';
  files['src/app/app.ts'] = `import { Component } from '@angular/core';
${list.map((c) => `import { ${c.name} } from './features/${c.feature}';`).join('\n')}

@Component({
  selector: 'app-root',
  imports: [${list.map((c) => c.name).join(', ')}],
  template: \`
    <main${crash ? ' [attr.data-theme]="theme"' : ''}>
      <h1>{{ title }}</h1>
${indent(list.map((c) => `<app-${c.feature} />`), 6)}
    </main>
  \`,
})
export class App {
  protected readonly title = '${title}';${crash ? `\n  private readonly settings = (globalThis as any).__APP_SETTINGS__;\n  protected readonly theme = this.settings.theme;` : ''}
}
`;
  files['src/app/app.config.ts'] = `import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';\nimport { provideHttpClient, withFetch } from '@angular/common/http';\n\nexport const appConfig: ApplicationConfig = {\n  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient(withFetch())],\n};\n`;
  files['src/main.ts'] = `import { bootstrapApplication } from '@angular/platform-browser';\nimport { appConfig } from './app/app.config';\nimport { App } from './app/app';\n\nbootstrapApplication(App, appConfig).catch((err) => console.error(err));\n`;
  files['src/styles.css'] = STYLE;
  files['src/index.html'] = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>${title}</title>\n  <base href="/">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n  <app-root></app-root>\n</body>\n</html>\n`;
  if (meta.features.includes('fetch')) files['public/data/products.json'] = DATA + '\n';
  const project = meta.id.replace(/^\d+-/, 'app-');
  files['angular.json'] =
    JSON.stringify(
      {
        $schema: './node_modules/@angular/cli/lib/config/schema.json',
        version: 1,
        cli: { packageManager: 'npm', analytics: false },
        newProjectRoot: 'projects',
        projects: {
          [project]: {
            projectType: 'application',
            root: '',
            sourceRoot: 'src',
            prefix: 'app',
            architect: {
              build: {
                builder: '@angular/build:application',
                options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json', assets: [{ glob: '**/*', input: 'public' }], styles: ['src/styles.css'] },
                configurations: {
                  production: { budgets: [{ type: 'initial', maximumWarning: '500kB', maximumError: '1MB' }], outputHashing: 'all' },
                  development: { optimization: false, extractLicenses: false, sourceMap: true },
                },
                defaultConfiguration: 'production',
              },
              serve: {
                builder: '@angular/build:dev-server',
                configurations: { production: { buildTarget: `${project}:build:production` }, development: { buildTarget: `${project}:build:development` } },
                defaultConfiguration: 'development',
              },
            },
          },
        },
      },
      null,
      2,
    ) + '\n';
  files['tsconfig.json'] = JSON.stringify({ compileOnSave: false, compilerOptions: { strict: true, noImplicitOverride: true, noPropertyAccessFromIndexSignature: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true, skipLibCheck: true, isolatedModules: true, experimentalDecorators: true, importHelpers: true, target: 'ES2022', module: 'preserve' }, angularCompilerOptions: { enableI18nLegacyMessageIdFormat: false, strictInjectionParameters: true, strictInputAccessModifiers: true, strictTemplates: true }, files: [], references: [{ path: './tsconfig.app.json' }] }, null, 2) + '\n';
  files['tsconfig.app.json'] = JSON.stringify({ extends: './tsconfig.json', compilerOptions: { types: [] }, include: ['src/**/*.ts'] }, null, 2) + '\n';
  const ng = VERSIONS.angular;
  files['package.json'] = pkg(
    meta.id,
    { ng: 'ng', start: 'ng serve', build: 'ng build', watch: 'ng build --watch --configuration development' },
    { '@angular/common': ng, '@angular/compiler': ng, '@angular/core': ng, '@angular/forms': ng, '@angular/platform-browser': ng, '@angular/router': ng, rxjs: '~7.8.0', tslib: '^2.3.0', ...featureDeps(meta, false) },
    { '@angular/build': VERSIONS.angularCli, '@angular/cli': VERSIONS.angularCli, '@angular/compiler-cli': ng, typescript: '~6.0.2' },
    false,
  );
  return files;
}

function litApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/features/${f}.ts`, kit('lit', '/data/products.json'));
  const crash = meta.fault === 'crash';
  files['src/app-root.ts'] = `import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
${list.map((c) => `import './features/${c.feature}';`).join('\n')}

@customElement('app-root')
export class AppRoot extends LitElement {
  static styles = css\`
    main {
      max-width: 40rem;
      margin: 2rem auto;
      padding: 0 1rem;
    }
  \`;

  render() {
${crash ? indent(CRASH_TS.trim().split('\n'), 4) + '\n' : ''}    return html\`
      <main${crash ? ' data-theme=${theme}' : ''}>
        <h1>${title}</h1>
${indent(list.map((c) => `<${c.feature}-feature></${c.feature}-feature>`), 8)}
      </main>
    \`;
  }
}
`;
  files['src/main.ts'] = `import './index.css';\nimport './app-root';\n`;
  files['src/index.css'] = `body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n}\n`;
  files['index.html'] = html(title, `    <app-root></app-root>\n    <script type="module" src="/src/main.ts"></script>`);
  if (meta.features.includes('fetch')) files['public/data/products.json'] = DATA + '\n';
  files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'es2023', experimentalDecorators: true, useDefineForClassFields: false, module: 'esnext', lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['vite/client'], skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true, moduleDetection: 'force', noEmit: true, strict: true }, include: ['src'] }, null, 2) + '\n';
  files['package.json'] = pkg(meta.id, { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' }, { lit: VERSIONS.lit, ...featureDeps(meta, false) }, { typescript: '~6.0.2', vite: '^8.3.5' }, true);
  return files;
}

function astroApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  const list = components(meta, files, (f) => `src/features/${f}.ts`, vanillaSource('/api/products.json'));
  for (const c of list) {
    files[`src/components/${c.name}.astro`] = `<div data-feature="${c.feature}"></div>

<script>
  import { mount } from '../features/${c.feature}';

  for (const el of document.querySelectorAll<HTMLElement>('[data-feature="${c.feature}"]')) mount(el);
</script>
`;
  }
  const crash = meta.fault === 'crash';
  files['src/pages/index.astro'] = `---
import Layout from '../layouts/Layout.astro';
${list.map((c) => `import ${c.name} from '../components/${c.name}.astro';`).join('\n')}
${crash ? `\n${CRASH_TS}` : ''}---

<Layout title="${title}">
  <main${crash ? ' data-theme={theme}' : ''}>
    <h1>${title}</h1>
${indent(list.map((c) => `<${c.name} />`), 4)}
  </main>
</Layout>
`;
  files['src/layouts/Layout.astro'] = `---
interface Props {
  title: string;
}
const { title } = Astro.props;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
  </head>
  <body>
    <slot />
  </body>
</html>

<style is:global>
${STYLE.trim()}
</style>
`;
  if (meta.features.includes('fetch')) files['src/pages/api/products.json.ts'] = `import type { APIRoute } from 'astro';\n\nconst DATA = ${DATA};\n\nexport const GET: APIRoute = () => {\n  return new Response(JSON.stringify(DATA), {\n    headers: { 'Content-Type': 'application/json' },\n  });\n};\n`;
  files['astro.config.mjs'] = `// @ts-check\nimport { defineConfig } from 'astro/config';\n\n// https://astro.build/config\nexport default defineConfig({});\n`;
  files['tsconfig.json'] = JSON.stringify({ extends: 'astro/tsconfigs/strict', include: ['.astro/types.d.ts', '**/*'], exclude: ['dist'] }, null, 2) + '\n';
  files['package.json'] = pkg(meta.id, { dev: 'astro dev', build: 'astro build', preview: 'astro preview', astro: 'astro' }, { astro: VERSIONS.astro, ...featureDeps(meta, false) }, {}, true);
  return files;
}

/** Plain HTML, CSS and JavaScript modules, no package.json: the vanilla features with their types stripped. */
function staticApp(meta: AppMeta, title: string): Record<string, string> {
  const files: Record<string, string> = {};
  // esbuild moves the export to the end of the module: put it back on the function.
  const toJs = (ts: string) => transformSync(ts, { loader: 'ts', format: 'esm' }).code.replace(/\nexport \{\n {2}mount\n\};\n$/, '\n').replace(/^function mount\(/m, 'export function mount(');
  const list = meta.features.map((f) => ({ feature: f, file: `js/features/${f}.js` }));
  for (const c of list) files[c.file] = toJs(FEATURES[c.feature].vanilla!(meta.buggyFeature === c.feature));
  // The faults are seeded after type stripping: a syntax error would not get through esbuild.
  files[list[0].file] = seedFault(files[list[0].file], meta.fault);
  const crash = meta.fault === 'crash' ? `const settings = globalThis.__APP_SETTINGS__;\ndocument.body.dataset.theme = settings.theme;\n\n` : '';
  files['js/main.js'] = `${list.map((c, i) => `import { mount as mount${i} } from './features/${c.feature}.js';`).join('\n')}\n\n${crash}const main = document.querySelector('main');\n${list.map((_, i) => `mount${i}(main);`).join('\n')}\n`;
  files['style.css'] = STYLE;
  files['index.html'] = html(title, `    <main>\n      <h1>${title}</h1>\n    </main>\n    <script type="module" src="js/main.js"></script>`, `    <link rel="stylesheet" href="style.css" />\n`);
  if (meta.features.includes('fetch')) files['data/products.json'] = DATA + '\n';
  return files;
}
