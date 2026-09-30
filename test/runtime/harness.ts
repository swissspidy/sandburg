/**
 * Minimal harness for the node runtime: serves the worker bundle and the
 * compile endpoint on loopback and runs a program in Chromium. Used by the
 * runtime tests; no Sandburg session involved.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { bundleNodeRuntime, bundleSqlite, SQLITE_WASM } from '../../src/node-runtime/bundle.ts';
import { compileForRuntime, projectHasTopLevelAwait, type CompileKind } from '../../src/adapters/node/compile.ts';

const PAGE = `<!doctype html><script>
window.runNode = (files, main, requests) => new Promise((resolve) => {
  const w = new Worker('/__sandburg/node-worker.js');
  const out = { stdout: '', stderr: '', responses: [], fatal: null, exit: null };
  const bodies = new Map();
  let pending = requests.length;
  const finish = () => { w.terminate(); resolve(out); };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') w.postMessage({ type: 'run', main });
    else if (m.type === 'log') out[m.stream] += m.text;
    else if (m.type === 'fatal') { out.fatal = m.stack || m.message; finish(); }
    else if (m.type === 'exit') { out.exit = m.code; if (!requests.length) finish(); }
    else if (m.type === 'listening') requests.forEach((r, i) => w.postMessage({ type: 'request', id: i, port: m.port, method: r.method || 'GET', url: r.url, headers: [['host', 'localhost']], body: null }));
    else if (m.type === 'response-start') bodies.set(m.id, { status: m.status, headers: m.headers, chunks: [] });
    else if (m.type === 'response-chunk') bodies.get(m.id).chunks.push(new TextDecoder().decode(m.chunk));
    else if (m.type === 'response-end' || m.type === 'response-error') {
      const b = bodies.get(m.id) || { status: 0, chunks: [m.message] };
      out.responses[m.id] = { status: b.status, body: b.chunks.join(''), chunks: b.chunks.length };
      if (--pending === 0) finish();
    }
  };
  w.onerror = (e) => { out.fatal = 'worker error: ' + e.message; finish(); };
  w.postMessage({ type: 'init', cwd: '/app', env: {}, files, installKey: null, nodeModules: null, base: '/__sandburg' });
  if (!requests.length) setTimeout(finish, 3000);
});
window.runWs = (files, main, url, protocols, sends) => new Promise((resolve) => {
  const w = new Worker('/__sandburg/node-worker.js');
  const out = { stdout: '', stderr: '', events: [], fatal: null };
  const finish = () => { w.terminate(); resolve(out); };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') w.postMessage({ type: 'run', main });
    else if (m.type === 'log') out[m.stream] += m.text;
    else if (m.type === 'fatal') { out.fatal = m.stack || m.message; finish(); }
    else if (m.type === 'listening') w.postMessage({ type: 'ws-open', id: 1, port: m.port, url, headers: [['host', 'localhost']], protocols });
    else if (m.type === 'ws-accept') {
      out.events.push(['open', m.protocol]);
      for (const s of sends) w.postMessage(s === 'CLOSE' ? { type: 'ws-close', id: 1, code: 1000, reason: 'bye' } : { type: 'ws-send', id: 1, data: s });
    } else if (m.type === 'ws-reject') { out.events.push(['reject', m.status, m.message]); finish(); }
    else if (m.type === 'ws-message') out.events.push(['message', typeof m.data === 'string' ? m.data : Array.from(new Uint8Array(m.data))]);
    else if (m.type === 'ws-closed') { out.events.push(['closed', m.code, m.reason, m.wasClean]); setTimeout(finish, 50); }
  };
  w.postMessage({ type: 'init', cwd: '/app', env: {}, files, installKey: null, nodeModules: null, base: '/__sandburg' });
  setTimeout(finish, 3000);
});
</script>`;

export class RuntimeHarness {
  private server!: Server;
  private browser!: Browser;
  page!: Page;

  async open(): Promise<void> {
    const js = await bundleNodeRuntime();
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/__sandburg/node-worker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(js);
      }
      if (url.pathname === '/__sandburg/sqlite3.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(await bundleSqlite());
      }
      if (url.pathname === '/__sandburg/sqlite3.wasm') {
        res.writeHead(200, { 'content-type': 'application/wasm' });
        return res.end(await readFile(SQLITE_WASM));
      }
      if (url.pathname === '/__sandburg/tla-scan') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ topLevelAwait: projectHasTopLevelAwait(JSON.parse(Buffer.concat(chunks).toString())) }));
      }
      if (url.pathname === '/__sandburg/compile') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const out = compileForRuntime(Buffer.concat(chunks).toString(), url.searchParams.get('path') ?? '/x.js', (url.searchParams.get('kind') ?? 'cjs') as CompileKind, { asyncModules: url.searchParams.get('async') === '1' });
          res.writeHead(200, { 'content-type': 'text/javascript' });
          return res.end(out);
        } catch (e) {
          res.writeHead(400);
          return res.end(String((e as Error).message));
        }
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.browser = await chromium.launch({ executablePath: process.env.SANDBURG_CHROMIUM });
    this.page = await this.browser.newPage();
    await this.page.goto(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`);
  }

  runWebSocket(files: Record<string, string>, main: string, url: string, protocols: string[], sends: string[]) {
    return this.page.evaluate(([f, m, u, p, s]) => (window as unknown as { runWs: Function }).runWs(f, m, u, p, s), [files, main, url, protocols, sends] as const) as Promise<{
      stdout: string;
      stderr: string;
      fatal: string | null;
      events: unknown[][];
    }>;
  }

  run(files: Record<string, string>, main: string, requests: { url: string; method?: string }[] = []) {
    return this.page.evaluate(([f, m, r]) => (window as unknown as { runNode: Function }).runNode(f, m, r), [files, main, requests] as const) as Promise<{
      stdout: string;
      stderr: string;
      fatal: string | null;
      exit: number | null;
      responses: { status: number; body: string; chunks: number }[];
    }>;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.server?.close();
  }
}
