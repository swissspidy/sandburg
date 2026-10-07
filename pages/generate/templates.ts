/**
 * The scaffold the model starts from, per framework: a minimal project on the versions Sandburg's
 * fixtures run (fixtures/), so the model need not guess package versions or config. Every scaffold
 * has a backend and SQLite (node:sqlite, built into Node.js): the front-end frameworks get an
 * Express API behind their dev server's proxy, the full-stack frameworks use their own server code.
 * Each one shows "Hello" and the SQLite version read through its backend, which the site's build
 * checks (scripts/pages/build.ts).
 */
import type { FileTree } from '../../src/types.ts';

export interface Template {
  id: string;
  label: string;
  /** What the model is told about the stack, its backend and where the database is. */
  stack: string;
  files: FileTree;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

const css = `:root {
  font-family: system-ui, sans-serif;
  color-scheme: light dark;
}
body {
  margin: 0;
}
`;

/** SQLite through node:sqlite: synchronous, built into Node.js. */
const db = (comment = '') => `import { DatabaseSync } from 'node:sqlite';
${comment}
// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

export default db;
`;

/** An Express API on port 3001 (the front end's dev server proxies /api to it). */
const expressApi = (staticDir?: string) => `import express from 'express';
import db from './db.js';

const app = express();
app.use(express.json());
${staticDir ? `app.use(express.static('${staticDir}'));\n` : ''}
app.get('/api/health', (req, res) => {
  res.json({ sqlite: db.prepare('select sqlite_version() as version').get().version });
});

const port = process.env.PORT || ${staticDir ? 3000 : 3001};
app.listen(port, () => console.log(\`API listening on http://localhost:\${port}\`));
`;

const viteIndex = (entry: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;

const viteConfig = (plugin: string, importLine: string) => `import { defineConfig } from 'vite';
${importLine}

export default defineConfig({
  plugins: [${plugin}],
  server: {
    // The Express API (server/index.js).
    proxy: { '/api': 'http://localhost:3001' },
  },
});
`;

/** package.json of a front end with the Express API next to it, started together. */
const withApi = (client: string, dependencies: Record<string, string>, devDependencies: Record<string, string>) =>
  json({
    name: 'app',
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { dev: 'concurrently "npm:server" "npm:client"', server: 'node server/index.js', client },
    dependencies: { express: '^5.2.0', ...dependencies },
    devDependencies: { concurrently: '^10.0.0', ...devDependencies },
  });

const API_STACK = 'The backend is an Express 5 API in server/index.js on port 3001, behind the dev server\'s proxy for /api; `npm run dev` starts both with concurrently. Data in SQLite through node:sqlite (server/db.js). Keep the proxy and the ports.';

export const TEMPLATES: Template[] = [
  {
    id: 'react',
    label: 'React',
    stack: `React 19 on Vite 8 (JavaScript with JSX). ${API_STACK}`,
    files: {
      'package.json': withApi('vite', { react: '^19.3.0', 'react-dom': '^19.3.0' }, { '@vitejs/plugin-react': '^6.1.1', vite: '^8.3.1' }),
      'vite.config.js': viteConfig('react()', "import react from '@vitejs/plugin-react';"),
      'index.html': viteIndex('/src/main.jsx'),
      'src/main.jsx': `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\n\ncreateRoot(document.getElementById('app')).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
      'src/App.jsx': `import { useEffect, useState } from 'react';\n\nexport default function App() {\n  const [health, setHealth] = useState(null);\n  useEffect(() => {\n    fetch('/api/health').then((r) => r.json()).then(setHealth);\n  }, []);\n  return (\n    <main>\n      <h1>Hello</h1>\n      {health && <p>SQLite {health.sqlite}</p>}\n    </main>\n  );\n}\n`,
      'src/index.css': css,
      'server/index.js': expressApi(),
      'server/db.js': db(),
    },
  },
  {
    id: 'vue',
    label: 'Vue',
    stack: `Vue 3 single-file components on Vite 8 (JavaScript, <script setup>). ${API_STACK}`,
    files: {
      'package.json': withApi('vite', { vue: '^3.5.13' }, { '@vitejs/plugin-vue': '^6.0.0', vite: '^8.3.0' }),
      'vite.config.js': viteConfig('vue()', "import vue from '@vitejs/plugin-vue';"),
      'index.html': viteIndex('/src/main.js'),
      'src/main.js': `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\n\ncreateApp(App).mount('#app');\n`,
      'src/App.vue': `<script setup>\nimport { ref, onMounted } from 'vue';\n\nconst health = ref(null);\nonMounted(async () => {\n  health.value = await fetch('/api/health').then((r) => r.json());\n});\n</script>\n\n<template>\n  <main>\n    <h1>Hello</h1>\n    <p v-if="health">SQLite {{ health.sqlite }}</p>\n  </main>\n</template>\n`,
      'src/style.css': css,
      'server/index.js': expressApi(),
      'server/db.js': db(),
    },
  },
  {
    id: 'sveltekit',
    label: 'Svelte (SvelteKit)',
    stack:
      'SvelteKit 2 with Svelte 5 (runes: $state, $derived, $effect, $props) on Vite 8, JavaScript. Server code in +page.server.js (load, form actions) and +server.js (API routes); server-only modules in src/lib/server/. Data in SQLite through node:sqlite (src/lib/server/db.js).',
    files: {
      'package.json': json({
        name: 'app',
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: { dev: 'vite dev', build: 'vite build' },
        devDependencies: { '@sveltejs/adapter-auto': '^7.0.1', '@sveltejs/kit': '^2.63.0', '@sveltejs/vite-plugin-svelte': '^7.1.2', svelte: '^5.56.1', vite: '^8.0.16' },
      }),
      'vite.config.js': `import adapter from '@sveltejs/adapter-auto';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [sveltekit({ compilerOptions: { runes: true }, adapter: adapter() })],\n});\n`,
      'src/app.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    %sveltekit.head%\n  </head>\n  <body data-sveltekit-preload-data="hover">\n    <div style="display: contents">%sveltekit.body%</div>\n  </body>\n</html>\n`,
      'src/lib/server/db.js': db(),
      'src/routes/+page.server.js': `import db from '$lib/server/db.js';\n\nexport function load() {\n  return { sqlite: db.prepare('select sqlite_version() as version').get().version };\n}\n`,
      'src/routes/+page.svelte': `<script>\n  let { data } = $props();\n</script>\n\n<main>\n  <h1>Hello</h1>\n  <p>SQLite {data.sqlite}</p>\n</main>\n`,
    },
  },
  {
    id: 'angular',
    label: 'Angular',
    stack: `Angular 22 (standalone components, signals, TypeScript) on the Angular CLI's dev server (ng serve). The backend is an Express 5 API in server/index.js on port 3001, behind ng serve's proxy for /api (proxy.conf.json); \`npm run dev\` starts both with concurrently. Data in SQLite through node:sqlite (server/db.js). Keep the proxy and the ports.`,
    files: {
      'package.json': withApi(
        'ng serve',
        { '@angular/common': '^22.2.0', '@angular/compiler': '^22.2.0', '@angular/core': '^22.2.0', '@angular/forms': '^22.2.0', '@angular/platform-browser': '^22.2.0', '@angular/router': '^22.2.0', rxjs: '~7.8.0', tslib: '^2.3.0' },
        { '@angular/build': '^22.2.0', '@angular/cli': '^22.2.0', '@angular/compiler-cli': '^22.2.0', typescript: '~6.0.2' },
      ),
      'angular.json': json({
        version: 1,
        cli: { packageManager: 'npm', analytics: false },
        projects: {
          app: {
            projectType: 'application',
            root: '',
            sourceRoot: 'src',
            prefix: 'app',
            architect: {
              build: {
                builder: '@angular/build:application',
                options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json', styles: ['src/styles.css'] },
                configurations: { development: { optimization: false, extractLicenses: false, sourceMap: true } },
                defaultConfiguration: 'development',
              },
              serve: {
                builder: '@angular/build:dev-server',
                options: { proxyConfig: 'proxy.conf.json' },
                configurations: { development: { buildTarget: 'app:build:development' } },
                defaultConfiguration: 'development',
              },
            },
          },
        },
      }),
      'proxy.conf.json': json({ '/api': { target: 'http://localhost:3001', secure: false } }),
      'tsconfig.json': json({
        compileOnSave: false,
        compilerOptions: { strict: true, skipLibCheck: true, isolatedModules: true, experimentalDecorators: true, importHelpers: true, target: 'ES2022', module: 'preserve' },
        angularCompilerOptions: { strictInjectionParameters: true, strictInputAccessModifiers: true, strictTemplates: true },
      }),
      'tsconfig.app.json': json({ extends: './tsconfig.json', compilerOptions: { types: [] }, include: ['src/**/*.ts'] }),
      'src/index.html': `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>App</title>\n  <base href="/">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n  <app-root></app-root>\n</body>\n</html>\n`,
      'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';\nimport { App } from './app/app';\n\nbootstrapApplication(App).catch((err) => console.error(err));\n`,
      'src/app/app.ts': `import { Component, signal } from '@angular/core';\n\n@Component({\n  selector: 'app-root',\n  template: \`\n    <main>\n      <h1>Hello</h1>\n      @if (sqlite()) {\n        <p>SQLite {{ sqlite() }}</p>\n      }\n    </main>\n  \`,\n})\nexport class App {\n  protected readonly sqlite = signal('');\n\n  constructor() {\n    fetch('/api/health')\n      .then((r) => r.json())\n      .then((health) => this.sqlite.set(health.sqlite));\n  }\n}\n`,
      'src/styles.css': css,
      'server/index.js': expressApi(),
      'server/db.js': db(),
    },
  },
  {
    id: 'solid-start',
    label: 'Solid (SolidStart)',
    stack:
      'SolidStart 2 with Solid 1.9 on Vite 8 (JavaScript with JSX). File routes in src/routes/ (pages, and API routes exporting GET/POST); server functions with "use server" inside query()/action() from @solidjs/router. Data in SQLite through node:sqlite (src/lib/db.js), used only from server functions and API routes.',
    files: {
      'package.json': json({
        name: 'app',
        type: 'module',
        private: true,
        scripts: { dev: 'vite dev', build: 'vite build' },
        dependencies: { '@solidjs/meta': '^0.29.4', '@solidjs/router': '^0.16.1', '@solidjs/start': '^2.0.5', 'solid-js': '^1.9.15', vite: '^8.0.16' },
      }),
      'vite.config.js': `import { defineConfig } from 'vite';\nimport { solidStart } from '@solidjs/start/config';\n\nexport default defineConfig({\n  plugins: [solidStart()],\n  // SolidStart's dev overlay imports a UMD file that only loads pre-bundled.\n  optimizeDeps: { include: ['@jridgewell/trace-mapping', '@jridgewell/resolve-uri'] },\n});\n`,
      'src/app.jsx': `import { MetaProvider, Title } from '@solidjs/meta';\nimport { Router } from '@solidjs/router';\nimport { FileRoutes } from '@solidjs/start/router';\nimport { Suspense } from 'solid-js';\nimport './app.css';\n\nexport default function App() {\n  return (\n    <Router\n      root={(props) => (\n        <MetaProvider>\n          <Title>App</Title>\n          <Suspense>{props.children}</Suspense>\n        </MetaProvider>\n      )}\n    >\n      <FileRoutes />\n    </Router>\n  );\n}\n`,
      'src/app.css': css,
      'src/entry-server.jsx': `// @refresh reload\nimport { createHandler, StartServer } from '@solidjs/start/server';\n\nexport default createHandler(() => (\n  <StartServer\n    document={({ assets, children, scripts }) => (\n      <html lang="en">\n        <head>\n          <meta charset="utf-8" />\n          <meta name="viewport" content="width=device-width, initial-scale=1" />\n          {assets}\n        </head>\n        <body>\n          <div id="app">{children}</div>\n          {scripts}\n        </body>\n      </html>\n    )}\n  />\n));\n`,
      'src/entry-client.jsx': `// @refresh reload\nimport { mount, StartClient } from '@solidjs/start/client';\n\nmount(() => <StartClient />, document.getElementById('app'));\n`,
      'src/lib/db.js': db(),
      'src/routes/index.jsx': `import { createAsync, query } from '@solidjs/router';\n\nconst getHealth = query(async () => {\n  'use server';\n  const { default: db } = await import('../lib/db.js');\n  return { sqlite: db.prepare('select sqlite_version() as version').get().version };\n}, 'health');\n\nexport default function Home() {\n  const health = createAsync(() => getHealth());\n  return (\n    <main>\n      <h1>Hello</h1>\n      <p>SQLite {health()?.sqlite}</p>\n    </main>\n  );\n}\n`,
    },
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    stack:
      'Next.js 16 with the App Router (JavaScript, no TypeScript), React 19. Server components by default; add "use client" to components with state or event handlers. Route handlers in app/api/**/route.js, server actions with "use server". Data in SQLite through node:sqlite (lib/db.js), used only in server code.',
    files: {
      'package.json': json({ name: 'app', version: '0.1.0', private: true, scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '16.4.0', react: '19.3.0', 'react-dom': '19.3.0' } }),
      'next.config.mjs': `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`,
      'lib/db.js': db(),
      'app/layout.js': `import './globals.css';\n\nexport const metadata = { title: 'App' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
      'app/page.js': `import db from '../lib/db.js';\n\n// Rendered on each request (it reads the database).\nexport const dynamic = 'force-dynamic';\n\nexport default function Page() {\n  const { version } = db.prepare('select sqlite_version() as version').get();\n  return (\n    <main>\n      <h1>Hello</h1>\n      <p>SQLite {version}</p>\n    </main>\n  );\n}\n`,
      'app/globals.css': css,
    },
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    stack:
      'Nuxt 4 with Vue 3 (JavaScript, <script setup>; auto-imported ref, computed, useFetch, $fetch). Pages in app/pages/ (or app/app.vue alone), server routes in server/api/ (defineEventHandler, readBody, getQuery). Data in SQLite through node:sqlite (server/db.js), used only from server routes.',
    files: {
      'package.json': json({ name: 'app', type: 'module', private: true, scripts: { dev: 'nuxt dev', build: 'nuxt build' }, dependencies: { nuxt: '^4.5.2', vue: '^3.5.22', 'vue-router': '^5.3.1' } }),
      'nuxt.config.js': `export default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n  devtools: { enabled: false },\n  css: ['~/assets/main.css'],\n});\n`,
      'app/assets/main.css': css,
      'app/app.vue': `<script setup>\nconst { data: health } = await useFetch('/api/health');\n</script>\n\n<template>\n  <main>\n    <h1>Hello</h1>\n    <p v-if="health">SQLite {{ health.sqlite }}</p>\n  </main>\n</template>\n`,
      'server/db.js': db(),
      'server/api/health.js': `import db from '../db.js';\n\nexport default defineEventHandler(() => {\n  return { sqlite: db.prepare('select sqlite_version() as version').get().version };\n});\n`,
    },
  },
  {
    id: 'astro',
    label: 'Astro',
    stack:
      'Astro 7 (.astro components; JavaScript). Pages in src/pages/, rendered on request in the dev server, so frontmatter can read the database; endpoints in src/pages/api/*.js export GET/POST. Interactivity with <script> tags in components. Data in SQLite through node:sqlite (src/lib/db.js), used only in frontmatter and endpoints.',
    files: {
      'package.json': json({ name: 'app', type: 'module', version: '0.0.1', private: true, scripts: { dev: 'astro dev', build: 'astro build' }, dependencies: { astro: '^7.3.5' } }),
      'astro.config.mjs': `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n`,
      'src/lib/db.js': db(),
      'src/styles/global.css': css,
      'src/pages/index.astro': `---\nimport db from '../lib/db.js';\nimport '../styles/global.css';\n\nconst { version } = db.prepare('select sqlite_version() as version').get();\n---\n\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>App</title>\n  </head>\n  <body>\n    <main>\n      <h1>Hello</h1>\n      <p>SQLite {version}</p>\n    </main>\n  </body>\n</html>\n`,
    },
  },
  {
    id: 'vanilla',
    label: 'HTML, CSS & JavaScript',
    stack:
      'Plain HTML, CSS and JavaScript (ES modules) in public/, no build step, served by an Express 5 server (server/index.js, port 3000) that also has the API under /api. Data in SQLite through node:sqlite (server/db.js). Packages for the page only from a CDN as ES modules (https://esm.sh/<package>), if at all.',
    files: {
      'package.json': json({ name: 'app', private: true, version: '0.0.0', type: 'module', scripts: { dev: 'node server/index.js' }, dependencies: { express: '^5.2.0' } }),
      'public/index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>App</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <main>\n      <h1>Hello</h1>\n      <p id="sqlite"></p>\n    </main>\n    <script type="module" src="app.js"></script>\n  </body>\n</html>\n`,
      'public/style.css': css,
      'public/app.js': `const health = await fetch('/api/health').then((r) => r.json());\ndocument.getElementById('sqlite').textContent = \`SQLite \${health.sqlite}\`;\n`,
      'server/index.js': expressApi('public'),
      'server/db.js': db(),
    },
  },
];

/** Earlier ids, from visitors' saved settings. */
const RENAMED: Record<string, string> = { svelte: 'sveltekit', 'vue-express-sqlite': 'vue' };

export function template(id: string): Template {
  return TEMPLATES.find((t) => t.id === (RENAMED[id] ?? id)) ?? TEMPLATES[0];
}
