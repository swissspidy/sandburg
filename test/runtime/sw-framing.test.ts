/**
 * The node adapter's service worker (adapters/node/sw.js) and an app that refuses to be framed: the app
 * renders in the host page's frame, on the host page's origin, so X-Frame-Options is dropped and CSP's
 * frame-ancestors becomes 'self' (issue #159). In Chromium, with the worker itself; the host page here
 * stands in for the runtime (it answers each forwarded request from a table).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { source } from '../../src/sources.ts';

const HTML = '<!doctype html><html><head><title>the app</title></head><body>the app</body></html>';

/** What the app answers, by path: its status and headers (with HTML for a body). */
const APP: Record<string, { status: number; headers: [string, string][] }> = {
  '/plain': { status: 200, headers: [] },
  '/deny': { status: 200, headers: [['X-Frame-Options', 'DENY']] },
  '/same': { status: 200, headers: [['X-Frame-Options', 'SAMEORIGIN']] },
  '/deny-with-csp': { status: 200, headers: [['X-Frame-Options', 'DENY'], ['Content-Security-Policy', "script-src 'self'"]] },
  '/helmet': { status: 200, headers: [['Content-Security-Policy', "default-src 'self';base-uri 'self';Frame-Ancestors 'none';object-src 'none'"]] },
  '/policies': {
    status: 200,
    headers: [
      // Two policies in one header (comma-joined), and a second header; a directive whose name only starts with frame-ancestors is not it.
      ['content-security-policy', "frame-ancestors 'none'; img-src 'self', script-src 'self' ; FRAME-ANCESTORS https://elsewhere.test"],
      ['Content-Security-Policy', "object-src 'none';frame-ancestors 'none';frame-ancestors-x y"],
      ['content-security-policy-report-only', "frame-ancestors 'none'; report-uri /csp"],
      ['x-frame-options', 'SAMEORIGIN'],
    ],
  },
  '/no-content': { status: 204, headers: [['x-frame-options', 'DENY'], ['content-security-policy', "frame-ancestors 'none'"]] },
};

let browser: Browser;
let server: Server;
let context: BrowserContext;
let page: Page;
let origin: string;
let otherOrigin: string;

before(async () => {
  const sw = await readFile(source('adapters/node/sw.js'), 'utf8');
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const js = { 'content-type': 'text/javascript' };
    if (path === '/__sw__.js') return res.writeHead(200, js).end(sw);
    if (path === '/__sandburg/ws-shim.js') return res.writeHead(200, js).end('');
    if (path === '/__sandburg/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>host</title><iframe id="app" title="app"></iframe>');
    // Another page (another run's), on another origin of the same site: it frames the app's paths.
    if (path === '/other') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>other</title>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // Two origins of one site, as runs are on *.sandburg.localhost: the app's and another page's.
  const port = (server.address() as AddressInfo).port;
  origin = `http://app.sb.localhost:${port}`;
  otherOrigin = `http://other.sb.localhost:${port}`;
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(`${origin}/__sandburg/`);
  // The host page: registers the worker, gives it a port and answers what it forwards, as the runtime would.
  await page.evaluate(
    async ([app, html]) => {
      const registration = await navigator.serviceWorker.register('/__sw__.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        const { id, url } = e.data as { id: number; url: string };
        const answer = app[url] ?? { status: 404, headers: [] };
        const body = new TextEncoder().encode(html).buffer;
        channel.port1.postMessage({ type: 'full', id, status: answer.status, statusText: '', headers: [['content-type', 'text/html'], ...answer.headers], body }, [body]);
      };
      const claimed = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
      registration.active!.postMessage({ type: 'sandburg-port' }, [channel.port2]);
      await claimed;
    },
    [APP, HTML] as const,
  );
});
after(async () => {
  await browser.close();
  server.close();
});

/** Loads `path` in the host page's frame; the title of what it shows (null: the browser's error page, which the host cannot read). */
function framed(path: string): Promise<string | null> {
  return page.evaluate(
    (path) =>
      new Promise<string | null>((resolve) => {
        const frame = document.getElementById('app') as HTMLIFrameElement;
        frame.addEventListener(
          'load',
          () => {
            try {
              resolve(frame.contentDocument?.title ?? null);
            } catch {
              resolve(null);
            }
          },
          { once: true },
        );
        frame.src = path;
      }),
    path,
  );
}

/** The headers (and status) the worker answers `path` with. */
function fetched(path: string): Promise<{ status: number; headers: Record<string, string> }> {
  return page.evaluate(async (path) => {
    const res = await fetch(path);
    return { status: res.status, headers: Object.fromEntries(res.headers) };
  }, path);
}

test('an app that sends no framing headers renders in the frame', async () => {
  assert.equal(await framed('/plain'), 'the app');
});

test("an app that sends X-Frame-Options: DENY renders in the frame: the header becomes frame-ancestors 'self'", async () => {
  assert.equal(await framed('/deny'), 'the app');
  const { headers } = await fetched('/deny');
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['content-security-policy'], "frame-ancestors 'self'");
});

test("X-Frame-Options: SAMEORIGIN, and with a CSP that has no frame-ancestors: frame-ancestors 'self' in a policy of its own", async () => {
  assert.equal(await framed('/same'), 'the app');
  assert.equal((await fetched('/same')).headers['content-security-policy'], "frame-ancestors 'self'");
  assert.equal(await framed('/deny-with-csp'), 'the app');
  assert.equal((await fetched('/deny-with-csp')).headers['content-security-policy'], "script-src 'self', frame-ancestors 'self'");
});

test('a page on another origin of the site (another run) cannot frame an app that refuses it; one that does not refuse it, it can', async () => {
  const other = await context.newPage();
  await other.goto(`${otherOrigin}/other`);
  const shows = async (path: string) => {
    await other.evaluate(
      (src) =>
        new Promise<void>((resolve) => {
          document.querySelector('iframe')?.remove();
          const frame = document.createElement('iframe');
          frame.addEventListener('load', () => resolve(), { once: true });
          frame.src = src;
          document.body.append(frame);
        }),
      `${origin}${path}`,
    );
    const frame = other.frames().find((f) => f !== other.mainFrame());
    return frame?.url().startsWith('chrome-error:') ? null : await frame!.title();
  };
  try {
    assert.equal(await shows('/plain'), 'the app');
    for (const path of ['/deny', '/same', '/helmet', '/deny-with-csp']) assert.equal(await shows(path), null, path);
  } finally {
    await other.close();
  }
});

test("an app whose CSP says frame-ancestors 'none' (Helmet's defaults) renders, its other directives kept", async () => {
  assert.equal(await framed('/helmet'), 'the app');
  assert.equal((await fetched('/helmet')).headers['content-security-policy'], "default-src 'self';base-uri 'self';frame-ancestors 'self';object-src 'none'");
});

test('frame-ancestors becomes self in every policy of every CSP header, report-only too', async () => {
  assert.equal(await framed('/policies'), 'the app');
  const { headers } = await fetched('/policies');
  assert.equal(
    headers['content-security-policy'],
    "frame-ancestors 'self'; img-src 'self', script-src 'self' ; frame-ancestors 'self', object-src 'none';frame-ancestors 'self';frame-ancestors-x y",
  );
  assert.equal(headers['content-security-policy-report-only'], "frame-ancestors 'self'; report-uri /csp");
  assert.equal(headers['x-frame-options'], undefined);
});

test('a response without a body (204) keeps its status, without the framing headers', async () => {
  const { status, headers } = await fetched('/no-content');
  assert.equal(status, 204);
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['content-security-policy'], "frame-ancestors 'self'");
});
