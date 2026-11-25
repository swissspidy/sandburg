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

/** A project the embedding page runs: a Node server with no packages, which answers / and /data.txt. */
const PROJECT = {
  'package.json': JSON.stringify({ name: 'embedded', private: true, scripts: { dev: 'node server.js' } }),
  'server.js': [
    "require('node:http').createServer((q, s) => {",
    "  if (q.url === '/data.txt') return s.end('from the app');",
    "  s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>node ' + process.version + '</h1>');",
    '}).listen(3000);',
  ].join('\n'),
};

/** The embedder's page, at /play/: the runtime is served from /sandburg/, its own files from /play/own/. */
const PAGE = `<!doctype html><title>embedder</title><p id="status">booting</p><iframe id="app"></iframe>
<script type="module">
import { isolate, loadHost, startProject, appPath, guardAppFrame } from '/sandburg/index.js';
const options = { base: '/sandburg/', scope: '/play/', pass: ['/play/own/'] };
const status = (s) => (document.getElementById('status').textContent = s);
try {
  if (await isolate(options)) {
    const host = await loadHost(options);
    guardAppFrame(document.getElementById('app'), appPath(options));
    const { url } = await startProject(host, ${JSON.stringify(PROJECT)}, options);
    status('started ' + url + ' isolated=' + crossOriginIsolated + ' own=' + (await (await fetch('/play/own/file.txt')).text()));
  }
} catch (e) {
  status('error: ' + e.message);
}
</script>`;

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
    if (path.startsWith('/sandburg/')) {
      const file = normalize(join(dir, path.slice('/sandburg/'.length)));
      if (!file.startsWith(dir + sep)) return void res.writeHead(404).end();
      const body = await readFile(file).catch(() => null);
      if (!body) return void res.writeHead(404).end();
      // The page is outside the runtime's directory: the service worker's scope may reach it only with this header.
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...(path === '/sandburg/sw.js' && { 'service-worker-allowed': '/play/' }) });
      return void res.end(body);
    }
    if (path === '/play/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/play/own/file.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('the embedder');
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

test("an embedding page runs a project's Node server in the browser, from the runtime's static files, cross-origin isolated by its service worker", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/play/`);
    // isolate() registers the service worker and reloads the page once; then the project runs.
    await page.waitForFunction(() => /^(started|error)/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 120_000 });
    assert.equal(await page.textContent('#status'), 'started / isolated=true own=the embedder');
    const app = page.frameLocator('#app');
    assert.match((await app.locator('h1').textContent()) ?? '', /^node v24\./);
    // The app's own absolute paths go to its server; it sees itself at /.
    assert.equal(await app.locator('h1').evaluate(async () => [location.pathname, await (await fetch('/data.txt')).text()].join(' ')), '/ from the app');
  } finally {
    await page.close();
  }
});
