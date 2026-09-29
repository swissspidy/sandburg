import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { Resolver, readAliases, resolveExports, type FileSystem } from '../../src/adapters/esbuild/resolve.ts';
import { buildApp, loadEnv } from '../../src/adapters/esbuild/build.ts';
import { unsupportedPostcssPlugins, unsupportedVitePlugins } from '../../src/adapters/esbuild/index.ts';
import { scanCandidates, usesTailwind } from '../../src/adapters/esbuild/tailwind.ts';
import { projectFromFiles } from '../../src/project.ts';

function memfs(files: Record<string, string>): FileSystem & { files: Record<string, string> } {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i));
  return {
    files,
    isFile: (p) => p in files,
    isDir: (p) => dirs.has(p),
    readJson: async (p) => JSON.parse(files[p]),
  };
}

const PACKAGES = {
  '/node_modules/cond/package.json': JSON.stringify({
    name: 'cond',
    exports: { '.': { node: './node.js', browser: './browser.js', default: './index.js' }, './feature/*': './src/feature/*.js', './package.json': './package.json' },
  }),
  '/node_modules/cond/browser.js': 'export default "browser";',
  '/node_modules/cond/node.js': 'export default "node";',
  '/node_modules/cond/index.js': 'export default "default";',
  '/node_modules/cond/src/feature/a.js': 'export default "a";',
  '/node_modules/legacy/package.json': JSON.stringify({ name: 'legacy', main: 'lib/main.js', module: 'es/index.js', browser: { './lib/fs.js': './lib/fs-browser.js', fs: false } }),
  '/node_modules/legacy/es/index.js': 'export { read } from "../lib/fs.js";',
  '/node_modules/legacy/lib/main.js': 'module.exports = require("./fs.js");',
  '/node_modules/legacy/lib/fs.js': 'export const read = () => "disk";',
  '/node_modules/legacy/lib/fs-browser.js': 'export const read = () => "browser";',
  '/node_modules/cjs/package.json': JSON.stringify({ name: 'cjs' }),
  '/node_modules/cjs/index.js': 'module.exports = { answer: process.env.NODE_ENV === "development" ? 42 : 0 };',
};

test('exports: conditions, patterns and non-exported subpaths', async () => {
  const r = new Resolver(memfs(PACKAGES));
  assert.deepEqual(await r.resolve('cond', '/src/a.ts'), { path: '/node_modules/cond/browser.js' });
  assert.deepEqual(await r.resolve('cond/feature/a', '/src/a.ts'), { path: '/node_modules/cond/src/feature/a.js' });
  await assert.rejects(r.resolve('cond/secret', '/src/a.ts'), /not exported/);
  assert.equal(resolveExports({ import: './m.mjs', require: './c.cjs' }, '.'), './m.mjs');
  assert.equal(resolveExports('./x.js', './y'), null);
});

test('module field, browser field remapping and Node built-ins', async () => {
  const r = new Resolver(memfs(PACKAGES));
  assert.deepEqual(await r.resolve('legacy', '/src/a.ts'), { path: '/node_modules/legacy/es/index.js' });
  assert.deepEqual(await r.resolve('../lib/fs.js', '/node_modules/legacy/es/index.js'), { path: '/node_modules/legacy/lib/fs-browser.js' });
  assert.ok('empty' in (await r.resolve('node:fs', '/src/a.ts')));
  assert.ok('empty' in (await r.resolve('path', '/src/a.ts')));
  await assert.rejects(r.resolve('missing-pkg', '/src/a.ts'), /Could not resolve "missing-pkg"/);
});

test('project files: extensions, index files, .js → .ts, root-absolute paths and aliases', async () => {
  const fs = memfs({ '/src/App.tsx': '', '/src/lib/index.ts': '', '/src/util.ts': '', '/src/components/Button.tsx': '' });
  const r = new Resolver(fs, { '@': '/src', '~components': '/src/components' });
  assert.deepEqual(await r.resolve('./App', '/src/main.tsx'), { path: '/src/App.tsx' });
  assert.deepEqual(await r.resolve('./lib', '/src/main.tsx'), { path: '/src/lib/index.ts' });
  assert.deepEqual(await r.resolve('./util.js', '/src/main.tsx'), { path: '/src/util.ts' });
  assert.deepEqual(await r.resolve('/src/App.tsx', '/index.html'), { path: '/src/App.tsx' });
  assert.deepEqual(await r.resolve('@/util', '/src/components/Button.tsx'), { path: '/src/util.ts' });
  assert.deepEqual(await r.resolve('~components/Button', '/src/main.tsx'), { path: '/src/components/Button.tsx' });
  assert.deepEqual(await r.resolve('./logo.svg?url', '/src/main.tsx').catch((e) => e.message), 'Could not resolve "./logo.svg?url" from /src/main.tsx');
});

test('aliases come from tsconfig paths and vite.config', () => {
  const aliases = readAliases({
    'tsconfig.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, }, }',
    'vite.config.ts': "resolve: { alias: { '~': path.resolve(__dirname, './src/lib'), '#x': fileURLToPath(new URL('./src/x', import.meta.url)) } }",
  });
  assert.deepEqual(aliases, { '@': '/src', '~': '/src/lib', '#x': '/src/x' });
});

test('.env files: VITE_ variables only, mode files win', () => {
  const env = loadEnv({ '.env': 'VITE_A=1\nSECRET=x\nVITE_B="two words" ', '.env.development': 'VITE_A=dev # comment' }, 'development');
  assert.deepEqual(env, { VITE_A: 'dev', VITE_B: 'two words' });
});

test('buildApp bundles index.html entries with packages, CSS and env', async () => {
  const project: Record<string, string> = {
    'index.html': '<html><head><title>%VITE_TITLE%</title></head><body><div id="root"></div><script type="module" src="/src/main.ts"></script></body></html>',
    'src/main.ts': 'import "./style.css";\nimport cond from "cond";\nimport { read } from "legacy";\nimport { answer } from "cjs";\nimport raw from "./note.txt?raw";\ndocument.body.dataset.out = [cond, read(), answer, raw, import.meta.env.VITE_TITLE, import.meta.env.DEV].join(",");\n',
    'src/style.css': 'body { color: red; }',
    'src/note.txt': 'hello',
    '.env': 'VITE_TITLE=Demo',
  };
  const out = await buildApp(esbuild, {
    files: project,
    nodeModules: Object.keys(PACKAGES),
    readNodeModule: async (p) => new TextEncoder().encode((PACKAGES as Record<string, string>)[p]),
  });
  assert.match(out.html, /<title>Demo<\/title>/);
  const js = /<script type="module" src="([^"]+)"/.exec(out.html)![1];
  const css = /<link rel="stylesheet" href="([^"]+)"/.exec(out.html)![1];
  assert.match(new TextDecoder().decode(out.assets.get(css)!.body), /color: red/);
  const code = new TextDecoder().decode(out.assets.get(js)!.body);
  assert.match(code, /"browser"/);
  assert.doesNotMatch(code, /"node"|"disk"/);
  assert.match(code, /"hello"/);
});

test('buildApp reports build errors with locations', async () => {
  await assert.rejects(
    buildApp(esbuild, {
      files: { 'index.html': '<script type="module" src="/src/main.ts"></script>', 'src/main.ts': 'import x from "./nope";\nconst = 1;' },
      nodeModules: [],
      readNodeModule: async () => new Uint8Array(),
    }),
    (e: Error) => e.name === 'BuildError' && /src\/main\.ts:\d+:\d+/.test(e.message),
  );
});

test('probe: Vite plugins other than React and Tailwind are reported', () => {
  const project = projectFromFiles(
    {
      'package.json': '{"devDependencies":{"vite":"^5"}}',
      'vite.config.ts': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nimport svgr from 'vite-plugin-svgr';\nimport path from 'node:path';\n",
    },
    { name: 'x', path: '/x' },
  );
  assert.deepEqual(unsupportedVitePlugins(project), ['vite-plugin-svgr']);
});

test('probe: PostCSS plugins other than Tailwind v4 and autoprefixer are reported', () => {
  const files = { 'postcss.config.mjs': "export default { plugins: { '@tailwindcss/postcss': {}, autoprefixer: {}, 'postcss-nesting': {} } };" };
  assert.deepEqual(unsupportedPostcssPlugins(projectFromFiles(files, { name: 'x', path: '/x' })), ['postcss-nesting']);
});

test('Tailwind: detection and candidate scanning', () => {
  assert.ok(usesTailwind('@import "tailwindcss";'));
  assert.ok(usesTailwind("@import 'tailwindcss/theme.css' layer(theme);"));
  assert.ok(!usesTailwind('body { color: red }'));
  const c = scanCandidates({ 'src/App.tsx': '<div className={`p-4 ${on ? "bg-[#fff]" : "hover:underline"}`}>', 'node_modules/x/a.js': 'nope-class' });
  for (const k of ['p-4', 'bg-[#fff]', 'hover:underline']) assert.ok(c.includes(k), k);
  assert.ok(!c.includes('nope-class'));
});
