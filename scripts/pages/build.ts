/**
 * Builds the static demo site (GitHub Pages): runs each demo project in a Sandburg session,
 * records what the host answered (installed files, the runtime's worker, compiled modules,
 * the install's description), and writes a site whose service worker (pages/sw.js) replays
 * those answers. The runtime, the dev servers and the app then run in the visitor's browser.
 *
 *   node scripts/pages/build.ts [--out dist-pages] [--only name,name] [--verify]
 *
 * Each project runs twice: the second run is the one a later run of Sandburg makes (the
 * install's preload bundle, Vite's pre-bundled dependencies, the Next.js seed cache), and
 * both runs' requests are kept. --verify then loads every demo from a local static server,
 * under a path prefix as on GitHub Pages, and fails on requests that were not recorded.
 *
 * The generator page (generate/, pages/generate/) needs no recording: it installs packages from the
 * npm registry and compiles in the page, and the site serves the runtime's own files (runtime/).
 * --verify runs each of its framework scaffolds, without a model; that needs the npm registry.
 * --only generate builds the generator alone.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { bundleBrowserCompiler, COMPILE_WORKER, ESBUILD_WASM } from '../../src/adapters/node/compile-wasm-bundle.ts';
import { bundleNodeRuntime, bundleSqlite, SQLITE_WASM } from '../../src/node-runtime/bundle.ts';
import { TEMPLATES } from '../../pages/generate/templates.ts';
import { chromium } from 'playwright-core';
import { Session } from '../../src/index.ts';
import { node } from '../../src/adapters/node/index.ts';
import { bundleHost } from '../../src/orchestrator/host-server.ts';
import { launchOptions } from '../../src/orchestrator/session.ts';
import { loadChecks } from '../../src/orchestrator/checks.ts';
import { expect } from '@playwright/test';
import type { HostInstall } from '../../src/adapters/node/browser.ts';
import type { Project } from '../../src/types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DEMOS = [
  { name: 'nextjs', fixture: 'fixtures/next-app-router', title: 'Next.js 16', command: 'next dev', description: 'An App Router app with a server component, an API route and client-side navigation, on next dev with webpack and SWC.', stack: 'Next.js 16, React 19, webpack and SWC (WebAssembly).' },
  { name: 'vite-react', fixture: 'fixtures/vite-react-counter', title: 'Vite + React', command: 'vite', description: 'The classic counter on Vite 8 with hot module replacement.', stack: 'Vite 8, React 19, rolldown (WebAssembly).' },
  { name: 'vue-express-sqlite', fixture: 'fixtures/vue-express-sqlite', title: 'Vue + Express + SQLite', command: 'concurrently "vite" "node server"', description: 'A full-stack todo app: Vue on Vite, an Express API behind Vite\'s proxy, data in SQLite.', stack: 'Vue 3 and Vite, Express, SQLite (WebAssembly), started by concurrently.' },
  { name: 'sveltekit', fixture: 'fixtures/sveltekit-app', title: 'SvelteKit', command: 'vite dev', description: 'A SvelteKit app with server load functions and form actions, on Vite 8.', stack: 'SvelteKit 2, Svelte 5, Vite 8 with rolldown (WebAssembly).' },
  { name: 'angular', fixture: 'fixtures/angular-tasks', title: 'Angular 22', command: 'ng serve', description: 'A task list on the Angular CLI\'s own dev server, with signals and SCSS.', stack: 'Angular 22, @angular/build with esbuild and Sass.' },
] as const;

const { values: args } = parseArgs({ options: { out: { type: 'string', default: 'dist-pages' }, only: { type: 'string' }, verify: { type: 'boolean', default: false }, 'verify-only': { type: 'boolean', default: false } } });
const out = resolve(args.out!);
const demos = DEMOS.filter((d) => !args.only || args.only.split(',').includes(d.name));

/** Recorded answers: request key → [blob, content type, status]. */
type Manifest = Record<string, [string, string, number]>;

async function writeBlob(body: Uint8Array | string): Promise<{ id: string; bytes: number }> {
  const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const id = createHash('sha256').update(buf).digest('hex').slice(0, 32);
  const file = join(out, 'blobs', `${id}.gz`);
  if (!existsSync(file)) await writeFile(file, gzipSync(buf, { level: 9 }));
  return { id, bytes: (await stat(file)).size };
}

async function build(): Promise<void> {
  const manifestFile = join(out, 'manifest.json');
  const manifest: Manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : {};
  await mkdir(join(out, 'blobs'), { recursive: true });

  // Record what the host serves (the same answers for every run of the same content).
  let used = new Set<string>();
  const serve = node.serve!.bind(node);
  node.serve = async (req) => {
    let body: Buffer | undefined;
    const request = { ...req, body: async () => (body ??= await req.body()) };
    const res = await serve(request);
    if (!res || (req.method === 'POST' && req.path.startsWith('/__sandburg/dev-cache/'))) return res;
    const key = req.method === 'POST' ? `POST ${req.path}?${req.query} ${createHash('sha256').update(await request.body()).digest('hex')}` : req.path;
    const blob = await writeBlob(res.body);
    const entry: Manifest[string] = [blob.id, res.headers?.['content-type'] ?? 'application/octet-stream', res.status];
    manifest[key] = entry;
    used.add(key);
    // Compiles again under a key without the path (Vite's config file has a timestamp in its
    // name): the output depends on the path only through the loader (.tsx) and .mjs/.mts.
    if (req.path === '/__sandburg/compile') {
      const path = req.query.get('path') ?? '';
      const loose = `POST /__sandburg/compile#${req.query.get('kind')}|${req.query.get('async') ?? ''}|${path.endsWith('x') ? 'x' : ''}|${/\.m[jt]s$/.test(path) ? 'm' : ''} ${key.slice(key.lastIndexOf(' ') + 1)}`;
      manifest[loose] = entry;
      used.add(loose);
    }
    return res;
  };
  let captured: { project: Project; host: HostInstall } | null = null;
  const hostInstall = node.hostInstall!.bind(node);
  node.hostInstall = async (project, log, options) => {
    const host = (await hostInstall(project, log, options)) as HostInstall;
    if (!options?.seed) captured = { project, host };
    return host;
  };

  const index: { name: string; title: string; description: string; command: string; downloadBytes: number; requests: number }[] = [];
  const session = new Session();
  await session.open();
  try {
    for (const demo of demos) {
      used = new Set();
      let result;
      for (const attempt of [1, 2]) {
        captured = null;
        const checks = join(ROOT, demo.fixture, 'checks.spec.ts');
        result = await session.run(join(ROOT, demo.fixture), { checks: existsSync(checks) ? checks : undefined });
        const phases = Object.fromEntries(result.phases.map((p) => [p.name, p.durationMs]));
        console.log(`${demo.name} (run ${attempt}): ${result.status} ${result.failure?.message ?? ''} ${JSON.stringify(phases)}`);
        if (result.status !== 'passed') throw new Error(`${demo.name} did not pass: ${result.failure?.message}`);
      }
      const { project, host } = captured!;
      const dir = join(out, 'demos', demo.name);
      await mkdir(dir, { recursive: true });
      // The demo does not save caches (sw.js answers the upload) and needs no seed flag.
      const demoJson = JSON.stringify({ name: demo.name, files: project.files, packageJson: project.packageJson, framework: project.framework, host });
      await writeFile(join(dir, 'demo.json'), demoJson);
      const html = (await readFile(join(ROOT, 'pages/demo.html'), 'utf8')).replace(/\{\{(\w+)\}\}/g, (_, k: string) => escapeHtml(String((demo as Record<string, string>)[k] ?? '')));
      await writeFile(join(dir, 'index.html'), html);
      let downloadBytes = demoJson.length;
      for (const key of used) downloadBytes += (await stat(join(out, 'blobs', `${manifest[key][0]}.gz`))).size;
      index.push({ name: demo.name, title: demo.title, description: demo.description, command: demo.command, downloadBytes, requests: used.size });
    }
  } finally {
    await session.close();
  }

  // The host page and the service worker (the node runtime's, behind pages/sw.js).
  await writeFile(join(out, 'host.js'), await bundleHost(node));
  await cp(join(ROOT, 'src/adapters/node/sw.js'), join(out, 'sw-core.js'));
  // The compiler for what was not recorded (pages/compile.ts), with esbuild's WebAssembly build.
  await writeFile(join(out, 'compile.js'), await bundleBrowserCompiler(join(ROOT, 'pages/compile.ts')));
  await cp(ESBUILD_WASM, join(out, 'esbuild.wasm'));
  for (const file of ['sw.js', 'demo.js', 'frame-guard.js', 'isolation.js', 'index.html', 'style.css']) await cp(join(ROOT, 'pages', file), join(out, file));
  await buildGenerator();
  await writeFile(join(out, '.nojekyll'), '');
  await writeFile(manifestFile, JSON.stringify(manifest));
  const previous = existsSync(join(out, 'demos.json')) ? (JSON.parse(await readFile(join(out, 'demos.json'), 'utf8')) as typeof index) : [];
  const merged = DEMOS.map((d) => index.find((i) => i.name === d.name) ?? previous.find((p) => p.name === d.name)).filter(Boolean);
  await writeFile(join(out, 'demos.json'), JSON.stringify(merged, null, 2));
  console.log(`site: ${out} (${Object.keys(manifest).length} recorded answers)`);
}

/** The generator page, and the runtime's files that a run installing in the page needs from the site (see pages/sw.js). */
async function buildGenerator(): Promise<void> {
  const runtime = join(out, 'runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'node-worker.js'), await bundleNodeRuntime());
  await writeFile(join(runtime, 'compile-worker.js'), await bundleBrowserCompiler(COMPILE_WORKER));
  await writeFile(join(runtime, 'sqlite3.js'), await bundleSqlite());
  await cp(ESBUILD_WASM, join(runtime, 'esbuild.wasm'));
  await cp(SQLITE_WASM, join(runtime, 'sqlite3.wasm'));
  await cp(join(ROOT, 'src/adapters/node/ws-shim.js'), join(runtime, 'ws-shim.js'));
  const dir = join(out, 'generate');
  await mkdir(dir, { recursive: true });
  await cp(join(ROOT, 'pages/generate/index.html'), join(dir, 'index.html'));
  await esbuild.build({ entryPoints: [join(ROOT, 'pages/generate/main.ts')], outfile: join(dir, 'generator.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: 'linked', logLevel: 'warning' });
  // The key vault: inlined into a sandboxed frame by the page (pages/generate/vault.ts).
  await esbuild.build({ entryPoints: [join(ROOT, 'pages/generate/vault.ts')], outfile: join(dir, 'vault.js'), bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, logLevel: 'warning' });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.gz': 'application/gzip', '.wasm': 'application/wasm' };

/**
 * The verify server's host name. Not localhost: the dev servers accept localhost (Vite's
 * allowedHosts, Next.js' allowedDevOrigins), and GitHub Pages serves the demos from another host.
 */
const VERIFY_HOST = 'pages.sandburg.test';

/**
 * A throwaway certificate for VERIFY_HOST: service workers need a secure origin, and only localhost
 * is one over plain HTTP (Chromium ignores --unsafely-treat-insecure-origin-as-secure headless).
 */
async function verifyCertificate(): Promise<{ key: Buffer; cert: Buffer; spki: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-pages-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${VERIFY_HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = await readFile(join(dir, 'cert.pem'));
    // The browser trusts this certificate alone, by its public key (other hosts' certificates are checked).
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    return { key: await readFile(join(dir, 'key.pem')), cert, spki };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A browser that reaches VERIFY_HOST on this machine and accepts its certificate (`spki`). */
function verifyBrowser(spki: string, extra: Parameters<typeof chromium.launch>[0] = {}) {
  const options = { ...launchOptions({}), ...extra };
  const proxy = options.proxy && { ...options.proxy, bypass: `${options.proxy.bypass},${VERIFY_HOST}` };
  // One --ignore-certificate-errors-spki-list: launchOptions may have one for an extra CA.
  const SPKI = '--ignore-certificate-errors-spki-list=';
  const others = (options.args ?? []).filter((a) => !a.startsWith(SPKI));
  const keys = [...(options.args ?? []).filter((a) => a.startsWith(SPKI)).map((a) => a.slice(SPKI.length)), spki];
  return chromium.launch({
    ...options,
    proxy,
    args: [...others, `--host-resolver-rules=MAP ${VERIFY_HOST} 127.0.0.1`, `${SPKI}${keys.join(',')}`],
  });
}

/** Loads every demo from a static server under /sandburg/ (as on GitHub Pages); fails on unrecorded requests. */
async function verify(): Promise<void> {
  const prefix = '/sandburg/';
  const certificate = await verifyCertificate();
  const server = createServer(certificate, async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    let file = path.startsWith(prefix) ? join(out, decodeURIComponent(path.slice(prefix.length))) : null;
    if (file && (file.endsWith('/') || !extname(file))) file = join(file, 'index.html');
    const inside = file !== null && !relative(out, file).startsWith('..') && !isAbsolute(relative(out, file));
    const body = inside ? await readFile(file!).catch(() => null) : null;
    res.writeHead(body ? 200 : 404, { 'content-type': body ? (TYPES[extname(file!)] ?? 'application/octet-stream') : 'text/plain' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const browser = await verifyBrowser(certificate.spki);
  let failed = false;
  try {
    for (const demo of demos) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      if (process.env.DEBUG) page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      if (process.env.DEBUG) page.on('requestfailed', (r) => console.log(`  [requestfailed] ${r.url()} ${r.failure()?.errorText}`));
      const missing: string[] = [];
      page.on('console', (m) => {
        if (process.env.DEBUG) console.log(`  [console] ${m.text().slice(0, 300)}`);
        if (m.text().includes('[sandburg demo] not recorded')) missing.push(m.text());
      });
      const t = Date.now();
      await page.goto(`https://${VERIFY_HOST}:${port}${prefix}demos/${demo.name}/`);
      const status = await page
        .waitForFunction(() => ['done', 'failed'].includes(document.getElementById('status')?.dataset.state ?? ''), null, { timeout: 240_000 })
        .then(() => page.evaluate(() => document.getElementById('status')!.dataset.state))
        .catch(() => 'timeout');
      const text = await page.frameLocator('#app').locator('body').innerText({ timeout: 5000 }).catch(() => '');
      // The fixture's own checks, on the demo's app: it renders, hydrates and talks to its servers.
      const failedChecks = status === 'done' ? await demoChecks(page, demo.fixture) : [];
      const ok = status === 'done' && text.trim().length > 0 && !missing.length && !failedChecks.length;
      console.log(`verify ${demo.name}: ${status} in ${((Date.now() - t) / 1000).toFixed(1)} s, app text ${JSON.stringify(text.slice(0, 80))}${missing.length ? `, ${missing.length} unrecorded: ${missing.slice(0, 5).join(' | ')}` : ''}`);
      for (const f of failedChecks) console.log(`  check failed: ${f}`);
      if (!ok) {
        failed = true;
        console.log((await page.locator('#terminal').innerText().catch(() => '')).split('\n').slice(-25).join('\n'));
      }
      await page.screenshot({ path: join(out, 'demos', demo.name, 'screenshot.png') });
      // The gallery's thumbnail: the app alone.
      if (ok) await page.locator('#app').screenshot({ path: join(out, 'demos', demo.name, 'preview.png') });
      await context.close();
    }
    if (!args.only || args.only.split(',').includes('generate')) failed = (await verifyGenerator(certificate.spki, `https://${VERIFY_HOST}:${port}${prefix}generate/`)) || failed;
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) process.exitCode = 1;
}

/** Runs a demo fixture's checks against the demo page's app frame; returns the failures. */
async function demoChecks(page: import('playwright-core').Page, fixture: string): Promise<string[]> {
  const app = await (await page.$('#app'))?.contentFrame();
  if (!app) return ['the app frame is missing'];
  // The app's address under the demo (pages/sw.js): the app itself sees /.
  const base = new URL('app/', page.url()).href;
  const appUrl = (path: string) => new URL(path.replace(/^\/+/, ''), base).href;
  const failures: string[] = [];
  for (const [name, fn] of Object.entries(await loadChecks(join(ROOT, fixture, 'checks.spec.ts')))) {
    try {
      await fn({ app, page, expect: expect.configure({ timeout: 30_000 }), appUrl });
    } catch (e) {
      failures.push(`${name}: ${String((e as Error).message ?? e).split('\n')[0]}`);
    }
  }
  return failures;
}

/**
 * Runs each of the generator's framework scaffolds as the page runs a generated app: packages from
 * the npm registry, installed and compiled in the page. Returns whether one failed.
 */
async function verifyGenerator(spki: string, url: string): Promise<boolean> {
  // The page reaches the npm registry itself: no dead proxy (only the environment's own proxy, if any).
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const browser = await verifyBrowser(spki, { proxy: proxy ? { server: proxy, bypass: '<-loopback>,*.localhost' } : undefined });
  let failed = false;
  try {
    // VERIFY_TEMPLATES=angular,nuxt: only those scaffolds (when debugging one).
    for (const tpl of TEMPLATES.filter((t) => !process.env.VERIFY_TEMPLATES || process.env.VERIFY_TEMPLATES.split(',').includes(t.id))) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      if (process.env.DEBUG) page.on('console', (m) => console.log(`  [console] ${m.text().slice(0, 300)}`));
      const t = Date.now();
      await page.goto(`${url}?scaffold=${tpl.id}`);
      const status = await page
        .waitForFunction(() => ['done', 'failed'].includes(document.getElementById('status')?.dataset.state ?? ''), null, { timeout: 300_000 })
        .then(() => page.evaluate(() => document.getElementById('status')!.dataset.state))
        .catch(() => 'timeout');
      const text = await page.frameLocator('#app').locator('body').innerText({ timeout: 5000 }).catch(() => '');
      // Each scaffold reads the SQLite version through its backend.
      const ok = status === 'done' && /Hello/.test(text) && /SQLite \d/.test(text);
      console.log(`verify generator ${tpl.id}: ${status} in ${((Date.now() - t) / 1000).toFixed(1)} s, app text ${JSON.stringify(text.slice(0, 80))}`);
      if (!ok) {
        failed = true;
        console.log((await page.locator('#terminal').innerText().catch(() => '')).split('\n').slice(-25).join('\n'));
      }
      await page.screenshot({ path: join(out, 'generate', `screenshot-${tpl.id}.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return failed;
}

if (!args['verify-only']) {
  if (!args.only) await rm(out, { recursive: true, force: true });
  await build();
}
if (args.verify || args['verify-only']) await verify();
