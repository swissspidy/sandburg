/**
 * The runtime's script as a module the service worker answers from Cache Storage (ADR NNNN,
 * src/node-runtime/runtime-module.ts): the worker's script holds its messages until the module has
 * run, a later worker of the same browser context starts from V8's code for it, and nothing else
 * does. In Chromium, with the node adapter's own service worker; the module here stands in for the
 * runtime (it answers each message with what it got).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { source } from '../../src/sources.ts';
import { RUNTIME_MODULE, runtimeBootstrap } from '../../src/node-runtime/runtime-module.ts';
import { RuntimeHarness } from './harness.ts';

/** Functions the module runs as it is evaluated: compiled lazily without code, from the cache with it. */
const functions = Array.from({ length: 200 }, (_, i) => `function f${i}(n) { let s = 0; for (let j = 0; j < n; j++) s += (j * ${i}) % 7; return s; }`).join('\n');
const MODULE = `${functions}
let sum = 0;
${Array.from({ length: 200 }, (_, i) => `sum += f${i}(3);`).join(' ')}
self.addEventListener('message', (e) => postMessage({ data: e.data, ports: e.ports.length, sum, text: 'original' }));
`;
const DIGEST = createHash('sha256').update(MODULE).digest('hex');
let missing = false;

let browser: Browser;
let server: Server;
let origin: string;
let sw: string;
before(async () => {
  sw = await readFile(source('adapters/node/sw.js'), 'utf8');
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const js = { 'content-type': 'text/javascript' };
    if (path === '/__sw__.js') return res.writeHead(200, js).end(sw);
    if (path === '/__sandburg/node-worker.js') return res.writeHead(200, js).end(runtimeBootstrap(DIGEST));
    if (RUNTIME_MODULE.exec(path)?.[1] === DIGEST && !missing) return res.writeHead(200, js).end(MODULE);
    if (path === '/__sandburg/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>host</title>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await browser.close();
  server.close();
});

/** A host page controlled by the service worker, in a browser context of its own. */
async function hostPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/__sandburg/`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/__sw__.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  return { context, page };
}

interface Started {
  replies: { data: unknown; ports: number; sum: number; text: string }[];
  error: string | null;
}

/** Starts a runtime worker and posts three messages at once (the second with a port); what it answered. */
function start(page: Page): Promise<Started> {
  return page.evaluate(
    () =>
      new Promise<Started>((resolve) => {
        const w = new Worker('/__sandburg/node-worker.js');
        const out: Started = { replies: [], error: null };
        w.onmessage = (e) => {
          out.replies.push(e.data);
          if (out.replies.length === 3) {
            w.terminate();
            resolve(out);
          }
        };
        w.onerror = (e) => {
          e.preventDefault();
          out.error = e.message;
          resolve(out);
        };
        w.postMessage('init');
        const channel = new MessageChannel();
        w.postMessage('run', [channel.port2]);
        w.postMessage('request');
      }),
  );
}

/** Starts a runtime worker under tracing; whether V8 took the module's code from the cache, and how many functions it compiled lazily. */
async function traced(page: Page): Promise<{ started: Started; consumed: boolean; lazy: number }> {
  await browser.startTracing(page, { categories: ['v8', 'disabled-by-default-v8.compile'] });
  const started = await start(page);
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents: { name: string; tid: number; args?: { data?: { url?: string; consumedCacheSize?: number } } }[] };
  const compile = trace.traceEvents.find((e) => e.name === 'v8.compileModule' && e.args?.data?.url?.includes(DIGEST));
  assert.ok(compile, 'the module was compiled');
  const lazy = trace.traceEvents.filter((e) => e.name === 'V8.CompileCode' && e.tid === compile.tid).length;
  return { started, consumed: (compile.args?.data?.consumedCacheSize ?? 0) > 0, lazy };
}

test('messages sent before the module has run reach it, in order, with their ports', async () => {
  const { context, page } = await hostPage();
  const out = await start(page);
  assert.equal(out.error, null);
  assert.deepEqual(
    out.replies.map((r) => [r.data, r.ports]),
    [
      ['init', 0],
      ['run', 1],
      ['request', 0],
    ],
  );
  await context.close();
});

test("a later runtime of the context starts from V8's code for the module; another context's does not", async () => {
  const { context, page } = await hostPage();
  const first = await traced(page);
  assert.equal(first.consumed, false);
  assert.ok(first.lazy >= 200, `compiled ${first.lazy} functions`);
  const second = await traced(page);
  assert.equal(second.consumed, true);
  // The functions the module ran as it was evaluated came with it.
  assert.ok(second.lazy < 20, `compiled ${second.lazy} functions`);
  assert.equal(second.started.replies[0].sum, first.started.replies[0].sum);
  // Another context (another run, another sandbox) has nothing of this one's.
  const other = await hostPage();
  assert.equal((await traced(other.page)).consumed, false);
  await other.context.close();
  await context.close();
});

test('code is not used for other text under the URL: a replaced entry is compiled again', async () => {
  const { context, page } = await hostPage();
  await traced(page);
  // An app can write its own origin's Cache Storage: the same length, other code, under the module's URL.
  const url = `/__sandburg/runtime/${DIGEST}.mjs`;
  const planted = MODULE.replace("text: 'original'", "text: 'replaced'");
  assert.equal(planted.length, MODULE.length);
  await page.evaluate(
    async ([url, body]) => (await caches.open('sandburg-runtime')).put(url, new Response(body, { headers: { 'content-type': 'text/javascript' } })),
    [url, planted] as const,
  );
  const after = await traced(page);
  assert.equal(after.consumed, false);
  assert.equal(after.started.replies[0].text, 'replaced');
  await context.close();
});

test('a runtime whose module does not load fails as a worker whose script does not load', async () => {
  missing = true;
  try {
    const { context, page } = await hostPage();
    const out = await start(page);
    assert.match(out.error ?? '', /import|module|fetch/i);
    assert.deepEqual(out.replies, []);
    await context.close();
  } finally {
    missing = false;
  }
});

test("a host that serves the runtime's script itself as node-worker.js (a static deployment) runs programs as before", async () => {
  const h = new RuntimeHarness();
  await h.open();
  try {
    h.classicRuntime = true;
    const out = await h.run({ 'main.js': `console.log('classic', typeof require('fs').readFileSync); process.exit(0);` }, '/app/main.js');
    assert.equal(out.fatal, null, out.fatal ?? out.stderr);
    assert.equal(out.stdout, 'classic function\n');
    assert.ok(!h.asked.some((a) => a.includes('/__sandburg/runtime/')), h.asked.join('\n'));
  } finally {
    await h.close();
  }
});
