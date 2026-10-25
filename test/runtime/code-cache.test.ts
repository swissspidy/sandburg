/** V8's compiled code for the host's own scripts, kept across runs (src/orchestrator/code-cache.ts). In Chromium. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { CLASSIC_CHARSET, CodeCache, PageCode, classicBody, type HostScript } from '../../src/orchestrator/code-cache.ts';

// Large enough for DevTools to produce code for it (1 KB), with a function compiled only on call.
const SOURCE = `window.answer = (function () { function twice(x) { return x * 2; } return twice(21); })();\n//${'-'.repeat(4000)}\n`;
const OTHER = SOURCE.replace('x * 2', 'x * 3');
const script = (source = SOURCE): HostScript => ({ name: 'test', source: async () => source });

let browser: Browser;
let server: Server;
let origin: string;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
  server = createServer((req, res) => {
    const body = req.url === '/a.js' ? SOURCE : req.url === '/b.js' ? OTHER : null;
    if (body === null) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>t</title>');
    } else {
      res.writeHead(200, { 'content-type': `text/javascript; charset=${CLASSIC_CHARSET}` });
      res.end(classicBody(body));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await browser.close();
  server.close();
});

/** Loads `path` with `data` as its code in a new page; what the script computed, and how many scripts V8 took compiled code for. */
async function load(data: string, path = '/a.js', page?: Page): Promise<{ answer: unknown; deserialized: number }> {
  page ??= await (await browser.newContext()).newPage();
  if (page.url() === 'about:blank') await page.goto(`${origin}/`);
  const code = new PageCode(page, origin + path, Promise.resolve(data));
  assert.equal(await code.ready, true);
  await browser.startTracing(page, { categories: ['disabled-by-default-v8.compile'] });
  const ran = await code.load(page.mainFrame());
  await code.close();
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents: { name: string }[] };
  assert.equal(ran, true);
  return { answer: await page.evaluate(() => (window as unknown as { answer: unknown }).answer), deserialized: trace.traceEvents.filter((e) => e.name === 'V8.FinalizeDeserialization').length };
}

test('code produced in a context of its own is used by another context, for its URL', async () => {
  const data = await new CodeCache(browser, '', null).prepare(script());
  assert.ok(data);
  assert.deepEqual(await load(data), { answer: 42, deserialized: 1 });
});

test('code given for one URL does not apply to another, nor after the load', async () => {
  const data = (await new CodeCache(browser, '', null).prepare(script()))!;
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/`);
  const add = (u: string) => page.evaluate((src) => new Promise((r) => { const s = document.createElement('script'); s.src = src; s.onload = r; document.head.append(s); }), origin + u);
  const answer = () => page.evaluate(() => (window as unknown as { answer: unknown }).answer);
  await browser.startTracing(page, { categories: ['disabled-by-default-v8.compile'] });
  // Another script (b.js) loaded while the code is there for a.js: compiled from its own text.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Page.addCompilationCache', { url: `${origin}/a.js`, data });
  await add('/b.js');
  assert.equal(await answer(), 63);
  // a.js once the DevTools session that held the code is closed (as the checks do once axe-core has loaded): from its text too.
  await cdp.detach();
  await add('/a.js');
  assert.equal(await answer(), 42);
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents: { name: string }[] };
  assert.equal(trace.traceEvents.filter((e) => e.name === 'V8.FinalizeDeserialization').length, 0);
});

test('code that does not fit the script is not used: the script compiles from its text', async () => {
  const data = (await new CodeCache(browser, '', null).prepare(script()))!;
  // b.js has the same length as a.js but other text: V8 accepts the code by length (hence code is
  // produced from the host's own copy only), so a script of another length stands for "does not fit".
  const shorter = SOURCE.slice(0, -10);
  const other = (await new CodeCache(browser, '', null).prepare(script(shorter)))!;
  assert.notEqual(other, data);
  assert.deepEqual(await load(other), { answer: 42, deserialized: 0 });
  // Bytes that are no code at all, as from a damaged file.
  assert.deepEqual(await load(Buffer.alloc(Buffer.from(data, 'base64').length, 7).toString('base64')), { answer: 42, deserialized: 0 });
});

test('entries on disk: by the script text, the browser and the salt; a damaged one is produced again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-code-cache-'));
  try {
    const first = await new CodeCache(browser, 'flags', dir).prepare(script());
    const [file] = await readdir(dir);
    assert.match(file, /^test-[0-9a-f]{64}\.bin$/);
    const stored = await readFile(join(dir, file));
    assert.equal(stored.subarray(32).toString('base64'), first);
    // Read back by a new session's cache, without producing.
    let produced = 0;
    const counting = { ...browser, newContext: () => (produced++, browser.newContext()), version: () => browser.version() } as unknown as Browser;
    assert.equal(await new CodeCache(counting, 'flags', dir).prepare(script()), first);
    assert.equal(produced, 0);
    // Another text, or other flags: another entry, which replaces the old one.
    await new CodeCache(browser, 'flags', dir).prepare(script(OTHER));
    const [other] = (await readdir(dir)).filter((f) => f.endsWith('.bin'));
    assert.notEqual(other, file);
    await new CodeCache(browser, 'other flags', dir).prepare(script());
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.bin')).length, 1);
    await new CodeCache(browser, 'flags', dir).prepare(script());
    // A damaged entry (one byte of the code changed) is not used, and is replaced.
    const damaged = Buffer.from(stored);
    damaged[damaged.length - 5] ^= 0xff;
    await writeFile(join(dir, file), damaged);
    const again = await new CodeCache(counting, 'flags', dir).prepare(script());
    assert.equal(produced, 1);
    assert.ok(again);
    const rewritten = await readFile(join(dir, file));
    assert.ok(createHash('sha256').update(rewritten.subarray(32)).digest().equals(rewritten.subarray(0, 32)));
    assert.deepEqual(await load(again), { answer: 42, deserialized: 1 });
    // A directory it cannot write: the code is still produced, and used.
    await writeFile(join(dir, 'file'), '');
    assert.ok(await new CodeCache(browser, 'flags', join(dir, 'file', 'sub')).prepare(script()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a page whose code is not there yet loads nothing with it (the caller loads the script its own way)', async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${origin}/`);
  let give!: (d: string | null) => void;
  const code = new PageCode(page, `${origin}/a.js`, new Promise((r) => (give = r)));
  assert.equal(await code.load(page.mainFrame()), false);
  assert.equal(await page.evaluate(() => (window as unknown as { answer?: unknown }).answer), undefined);
  give(null); // no code at all
  assert.equal(await code.ready, false);
  assert.equal(await code.load(page.mainFrame()), false);
  await code.close();
});
