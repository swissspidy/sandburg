/**
 * sandburg serve (src/serve.ts, ADR 0075) in a browser: its page, on the browser runtime as
 * scripts/browser-runtime.ts builds it, installs and starts a project and shows the app. In Chromium.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { buildBrowserRuntime } from '../../scripts/browser-runtime.ts';
import { projectFromFiles } from '../../src/project.ts';
import { serve, type Served } from '../../src/serve.ts';

const project = projectFromFiles(
  {
    'package.json': JSON.stringify({ name: 'served', private: true, scripts: { dev: 'node server.js' } }),
    'server.js': [
      "require('node:http').createServer((q, s) => {",
      "  if (q.url === '/data.txt') return s.end('from the app');",
      "  s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>served by node ' + process.version + '</h1>');",
      '}).listen(3000);',
    ].join('\n'),
  },
  { name: 'served', path: 'served' },
);

let dir: string;
let served: Served;
let browser: Browser;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sandburg-serve-runtime-'));
  await buildBrowserRuntime(dir);
  served = await serve({ project, port: 0, runtimeDir: dir });
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
});

after(async () => {
  await browser?.close();
  await served?.close();
  await rm(dir, { recursive: true, force: true });
});

test("the served page installs and starts the project in the browser and shows the app, which sees itself at / and reaches its server", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(served.url);
    // The page registers the runtime's service worker and reloads once (cross-origin isolation), then runs the project.
    await page.waitForFunction(() => /^(Running|Failed)$/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 120_000 });
    assert.equal(await page.textContent('#status'), 'Running', (await page.textContent('#log')) ?? '');
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    const app = page.frameLocator('#app');
    assert.match((await app.locator('h1').textContent()) ?? '', /^served by node v24\./);
    assert.equal(await app.locator('h1').evaluate(async () => [location.pathname, await (await fetch('/data.txt')).text()].join(' ')), '/ from the app');
    assert.equal(await page.textContent('#address'), '/');
  } finally {
    await page.close();
  }
});
