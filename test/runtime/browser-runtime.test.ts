/**
 * The browser runtime as an embedder uses it (sandburg/browser-runtime, ADR 0074): its directory, as
 * scripts/browser-runtime.ts builds it, served as static files beside a page of the embedder's own,
 * which imports index.js and runs a project, without a Sandburg host. In Chromium.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { buildBrowserRuntime } from '../../scripts/browser-runtime.ts';

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' };

/** A project the embedding page runs: a Node server with no packages, which answers /, /data.txt and /index.json. */
const PROJECT = {
  'package.json': JSON.stringify({ name: 'embedded', private: true, scripts: { dev: 'node server.js' } }),
  'server.js': [
    "require('node:http').createServer((q, s) => {",
    "  if (q.url === '/data.txt') return s.end('from the app');",
    // A name that starts with one of the runtime's own files (index.js), for a runtime served at /.
    "  if (q.url === '/index.json') return s.end('{\"app\":true}');",
    "  s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>node ' + process.version + '</h1>');",
    '}).listen(3000);',
  ].join('\n'),
};

/**
 * An embedder's page: it imports the runtime's API from `base` and runs PROJECT with `options`, then
 * reads a file of its own (`own`, under `options.pass`).
 */
const page = (base: string, options: object, own: string) => `<!doctype html><title>embedder</title><p id="status">booting</p><iframe id="app"></iframe>
<script type="module">
import { isolate, loadHost, startProject, appPath, guardAppFrame } from '${base}index.js';
const options = ${JSON.stringify(options)};
const status = (s) => (document.getElementById('status').textContent = s);
try {
  if (await isolate(options)) {
    const host = await loadHost(options);
    guardAppFrame(document.getElementById('app'), appPath(options));
    const { url } = await startProject(host, ${JSON.stringify(PROJECT)}, options);
    status('started ' + url + ' isolated=' + crossOriginIsolated + ' own=' + (await (await fetch('${own}')).text()));
  }
} catch (e) {
  status('error: ' + e.message);
}
</script>`;

/** The runtime's files at the site's root (a runtime served at /), by path. */
const AT_ROOT = /^\/(index\.js|sw\.js|sw-core\.js|compile\.js|host\.js|frame-guard\.js|isolation\.js|runtime\/.+)$/;

const PAGES: Record<string, string> = {
  // The runtime at /sandburg/, the page at /play/, its own files under /play/own/.
  '/play/': page('/sandburg/', { base: '/sandburg/', scope: '/play/', pass: ['/play/own/'] }, '/play/own/file.txt'),
  // The runtime at the site's root; the scope given without its trailing slash.
  '/root/': page('/', { base: '/', scope: '/root', pass: ['/root/own/'] }, '/root/own/file.txt'),
};

let dir: string;
let server: Server;
let browser: Browser;
let origin: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sandburg-browser-runtime-'));
  await buildBrowserRuntime(dir);
  server = createServer((req, res) => void serve(req, res));
  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const runtimeFile = path.startsWith('/sandburg/') ? path.slice('/sandburg/'.length) : AT_ROOT.test(path) ? path.slice(1) : null;
    if (runtimeFile !== null) {
      const file = normalize(join(dir, runtimeFile));
      if (!file.startsWith(dir + sep)) return void res.writeHead(404).end();
      const body = await readFile(file).catch(() => null);
      if (!body) return void res.writeHead(404).end();
      // A page outside the runtime's directory: the service worker's scope may reach it only with this header.
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...(path === '/sandburg/sw.js' && { 'service-worker-allowed': '/play/' }) });
      return void res.end(body);
    }
    if (Object.hasOwn(PAGES, path)) return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[path]);
    if (/^\/(play|root)\/own\/file\.txt$/.test(path)) return void res.writeHead(200, { 'content-type': 'text/plain' }).end('the embedder');
    res.writeHead(404).end();
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // localhost: a secure context over plain HTTP, as service workers and shared memory need.
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
});

after(async () => {
  await browser?.close();
  server?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Loads an embedder's page and checks that the project runs in it as it would on the developer's machine. */
async function runsInPage(path: string): Promise<void> {
  const tab = await browser.newPage();
  try {
    await tab.goto(origin + path);
    // isolate() registers the service worker and reloads the page once; then the project runs.
    await tab.waitForFunction(() => /^(started|error)/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 120_000 });
    assert.equal(await tab.textContent('#status'), 'started / isolated=true own=the embedder');
    const app = tab.frameLocator('#app');
    assert.match((await app.locator('h1').textContent()) ?? '', /^node v24\./);
    // The app's own absolute paths go to its server; it sees itself at /.
    const seen = await app.locator('h1').evaluate(async () => [location.pathname, await (await fetch('/data.txt')).text(), await (await fetch('/index.json')).text()].join(' '));
    assert.equal(seen, '/ from the app {"app":true}');
  } finally {
    await tab.close();
  }
}

test("an embedding page runs a project's Node server in the browser, from the runtime's static files, cross-origin isolated by its service worker", () => runsInPage('/play/'));

test("a runtime served at the site's root leaves the app's absolute paths to the app, and a scope may be given without its trailing slash", () => runsInPage('/root/'));
