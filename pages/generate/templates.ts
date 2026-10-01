/**
 * The scaffold the model starts from, per framework: a minimal project on the versions Sandburg's
 * fixtures run (fixtures/), so the model need not guess package versions or config.
 */
import type { FileTree } from '../../src/types.ts';

export interface Template {
  id: string;
  label: string;
  /** What the model is told about the stack. */
  stack: string;
  files: FileTree;
}

const viteIndex = (entry: string, title = 'App') => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;

const css = `:root {
  font-family: system-ui, sans-serif;
  color-scheme: light dark;
}
body {
  margin: 0;
}
`;

const pkg = (name: string, scripts: Record<string, string>, dependencies: Record<string, string>, devDependencies: Record<string, string>) =>
  JSON.stringify({ name, private: true, version: '0.0.0', type: 'module', scripts, dependencies, devDependencies }, null, 2) + '\n';

export const TEMPLATES: Template[] = [
  {
    id: 'react',
    label: 'React + Vite',
    stack: 'React 19 on Vite 8 (JavaScript with JSX).',
    files: {
      'package.json': pkg('app', { dev: 'vite', build: 'vite build' }, { react: '^19.3.0', 'react-dom': '^19.3.0' }, { '@vitejs/plugin-react': '^6.1.1', vite: '^8.3.1' }),
      'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`,
      'index.html': viteIndex('/src/main.jsx'),
      'src/main.jsx': `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\n\ncreateRoot(document.getElementById('app')).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
      'src/App.jsx': `export default function App() {\n  return <h1>Hello</h1>;\n}\n`,
      'src/index.css': css,
    },
  },
  {
    id: 'vue',
    label: 'Vue + Vite',
    stack: 'Vue 3 single-file components on Vite 8 (JavaScript, <script setup>).',
    files: {
      'package.json': pkg('app', { dev: 'vite', build: 'vite build' }, { vue: '^3.5.13' }, { '@vitejs/plugin-vue': '^6.0.0', vite: '^8.3.0' }),
      'vite.config.js': `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n});\n`,
      'index.html': viteIndex('/src/main.js'),
      'src/main.js': `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\n\ncreateApp(App).mount('#app');\n`,
      'src/App.vue': `<script setup>\n</script>\n\n<template>\n  <h1>Hello</h1>\n</template>\n`,
      'src/style.css': css,
    },
  },
  {
    id: 'svelte',
    label: 'Svelte + Vite',
    stack: 'Svelte 5 (runes: $state, $derived, $effect) on Vite 8, JavaScript.',
    files: {
      'package.json': pkg('app', { dev: 'vite', build: 'vite build' }, {}, { '@sveltejs/vite-plugin-svelte': '^7.3.0', svelte: '^5.57.0', vite: '^8.3.0' }),
      'vite.config.js': `import { defineConfig } from 'vite';\nimport { svelte } from '@sveltejs/vite-plugin-svelte';\n\nexport default defineConfig({\n  plugins: [svelte()],\n});\n`,
      'index.html': viteIndex('/src/main.js'),
      'src/main.js': `import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './app.css';\n\nmount(App, { target: document.getElementById('app') });\n`,
      'src/App.svelte': `<h1>Hello</h1>\n`,
      'src/app.css': css,
    },
  },
  {
    id: 'vanilla',
    label: 'HTML, CSS & JavaScript',
    stack: 'Plain HTML, CSS and JavaScript (ES modules), no build step and no package.json: a static file server serves the files as they are. Packages only from a CDN as ES modules (https://esm.sh/<package>), if at all.',
    files: {
      'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>App</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Hello</h1>\n    <script type="module" src="app.js"></script>\n  </body>\n</html>\n`,
      'style.css': css,
      'app.js': `// The app's code.\n`,
    },
  },
  {
    id: 'vue-express-sqlite',
    label: 'Vue + Express + SQLite',
    stack:
      'A full-stack app: a Vue 3 front end on Vite 8, an Express 5 API (server/index.js, port 3001) behind Vite\'s proxy (/api), data in SQLite with better-sqlite3 (server/db.js; synchronous API). `npm run dev` starts both with concurrently. Keep the proxy and the ports.',
    files: {
      'package.json':
        JSON.stringify(
          {
            name: 'app',
            private: true,
            version: '0.0.0',
            type: 'module',
            scripts: { dev: 'concurrently "npm:server" "npm:client"', server: 'node server/index.js', client: 'vite', build: 'vite build' },
            dependencies: { 'better-sqlite3': '^13.0.0', express: '^5.2.0', vue: '^3.5.13' },
            devDependencies: { '@vitejs/plugin-vue': '^6.0.0', concurrently: '^10.0.0', vite: '^8.3.0' },
          },
          null,
          2,
        ) + '\n',
      'vite.config.js': `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n  server: {\n    proxy: {\n      '/api': 'http://localhost:3001',\n    },\n  },\n});\n`,
      'server/db.js': `import Database from 'better-sqlite3';\n\nconst db = new Database('app.db');\ndb.pragma('journal_mode = WAL');\n\nexport default db;\n`,
      'server/index.js': `import express from 'express';\nimport db from './db.js';\n\nconst app = express();\napp.use(express.json());\n\napp.get('/api/health', (req, res) => {\n  res.json({ ok: true, sqlite: db.prepare('select sqlite_version() as v').get().v });\n});\n\nconst port = process.env.PORT || 3001;\napp.listen(port, () => console.log(\`API listening on http://localhost:\${port}\`));\n`,
      'index.html': viteIndex('/src/main.js'),
      'src/main.js': `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\n\ncreateApp(App).mount('#app');\n`,
      'src/App.vue': `<script setup>\nimport { ref, onMounted } from 'vue';\n\nconst health = ref(null);\nonMounted(async () => {\n  health.value = await fetch('/api/health').then((r) => r.json());\n});\n</script>\n\n<template>\n  <h1>Hello</h1>\n  <p v-if="health">SQLite {{ health.sqlite }}</p>\n</template>\n`,
      'src/style.css': css,
    },
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    stack: 'Next.js 16 with the App Router (JavaScript, no TypeScript), React 19. Server components by default; add "use client" to components with state or event handlers. Route handlers in app/api/**/route.js. Keep data in memory or in the browser (no database).',
    files: {
      'package.json': JSON.stringify({ name: 'app', version: '0.1.0', private: true, scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '16.3.8', react: '19.3.0', 'react-dom': '19.3.0' } }, null, 2) + '\n',
      'next.config.mjs': `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`,
      'app/layout.js': `import './globals.css';\n\nexport const metadata = { title: 'App' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
      'app/page.js': `export default function Page() {\n  return <h1>Hello</h1>;\n}\n`,
      'app/globals.css': css,
    },
  },
];

export function template(id: string): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
