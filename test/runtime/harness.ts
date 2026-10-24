/**
 * Minimal harness for the node runtime: serves the worker bundle and the
 * compile endpoint on loopback and runs a program in Chromium. Used by the
 * runtime tests; no Sandburg session involved.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { bundleNodeRuntime, bundleRuntimeLib, bundleSqlite, SPARE_SCRIPT, SQLITE_WASM } from '../../src/node-runtime/bundle.ts';
import { RUNTIME_LIBS, type RuntimeLib } from '../../src/node-runtime/libs.ts';
import { acceptFileChannel } from '../../src/orchestrator/host-socket.ts';
import type { HostRequest } from '../../src/types.ts';
import { compileForRuntime, projectHasTopLevelAwait, type CompileKind } from '../../src/adapters/node/compile.ts';

const PAGE = `<!doctype html><script>
// A bundle downloaded by the page into shared memory, as adapters/node/process.ts (prefetchBundle) does.
window.prefetch = (url) => {
  const sab = new SharedArrayBuffer(8, { maxByteLength: 1 << 24 });
  const state = new Int32Array(sab, 0, 2);
  fetch(url + '?by=page').then((r) => r.arrayBuffer()).then((b) => {
    sab.grow(8 + b.byteLength);
    new Uint8Array(sab, 8).set(new Uint8Array(b));
    Atomics.store(state, 1, b.byteLength);
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  });
  return sab;
};
window.runNode = (files, main, requests, extra = {}) => new Promise((resolve) => {
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
  const init = { type: 'init', cwd: '/app', env: {}, files, installKey: null, nodeModules: null, base: '/__sandburg', ...extra };
  if (extra.prefetch) init.prefetched = { [extra.preload]: window.prefetch(extra.preload) };
  // As the page does at a run's mount (adapters/node/browser.ts): the runtime starts its spares, then waits for init.
  const start = () => {
    w.postMessage(init);
    if (!requests.length) setTimeout(finish, 3000);
  };
  if (extra.spares) {
    w.postMessage({ type: 'spares' });
    setTimeout(start, extra.spares);
  } else start();
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

/** An install the harness serves (see runInstalled): node_modules files by path, and which of them its preload bundle has. */
interface Install {
  files: Record<string, string>;
  bundled: string[];
}
export const INSTALL_KEY = 'a'.repeat(24);

export class RuntimeHarness {
  private server!: Server;
  private browser!: Browser;
  page!: Page;
  private install: Install = { files: {}, bundled: [] };
  /** What the host was asked for: `http <path>` or `ws <path>`. */
  asked: string[] = [];
  /** Answer /__sandburg/node-spare.js with a 404, as a host that does not serve it. */
  noSpareScript = false;

  /** The host's answer for an install's file or its preload bundle, as the node adapter serves them. */
  private installed(path: string): Buffer | null {
    const m = /^\/__sandburg\/nm\/[0-9a-f]{24}\/(f|t)\/(.+)$/.exec(path);
    if (m) {
      const text = this.install.files[decodeURIComponent(m[2])];
      return text === undefined ? null : Buffer.from(text);
    }
    if (!path.startsWith('/__sandburg/preload/')) return null;
    const files = this.install.bundled.flatMap((rel) => ['f', 't'].map((mode) => [mode, rel, Buffer.from(this.install.files[rel])] as const));
    const header = Buffer.from(JSON.stringify(files.map(([mode, rel, bytes]) => [mode, rel, bytes.length])));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    return Buffer.concat([length, header, ...files.map((f) => f[2])]);
  }

  async open(): Promise<void> {
    const js = await bundleNodeRuntime();
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = this.installed(url.pathname);
      if (body || url.pathname.startsWith('/__sandburg/nm/')) {
        this.asked.push(`http ${url.pathname}${url.search}`);
        res.writeHead(body ? 200 : 404, { 'content-type': 'application/octet-stream' });
        return res.end(body ?? 'not found');
      }
      if (url.pathname === '/__sandburg/node-worker.js' || url.pathname === '/__sandburg/node-spare.js') {
        this.asked.push(`http ${url.pathname}`);
        if (this.noSpareScript && url.pathname.endsWith('spare.js')) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/javascript', 'cross-origin-embedder-policy': 'require-corp' });
        return res.end(url.pathname.endsWith('spare.js') ? SPARE_SCRIPT : js);
      }
      const lib = /^\/__sandburg\/node-([a-z]+)\.js$/.exec(url.pathname)?.[1];
      if (lib && Object.hasOwn(RUNTIME_LIBS, lib)) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(await bundleRuntimeLib(lib as RuntimeLib));
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
      res.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      res.end(PAGE);
    });
    this.server.on('upgrade', (req, socket) => {
      const origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
      acceptFileChannel(req, socket, origin, async (r: HostRequest) => {
        this.asked.push(`ws ${r.path}`);
        const body = this.installed(r.path);
        return body ? { status: 200, body } : null;
      });
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

  run(files: Record<string, string>, main: string, requests: { url: string; method?: string }[] = [], execArgv?: string[], options: { spares?: number } = {}) {
    return this.page.evaluate(([f, m, r, a]) => (window as unknown as { runNode: Function }).runNode(f, m, r, a), [files, main, requests, { ...(execArgv ? { execArgv } : {}), ...options }] as const) as Promise<{
      stdout: string;
      stderr: string;
      fatal: string | null;
      exit: number | null;
      responses: { status: number; body: string; chunks: number }[];
    }>;
  }

  /**
   * Runs a program with an install: node_modules files the runtime reads from the host, a preload
   * bundle of `bundled` (downloaded by the page as it starts the runtime if `prefetch`), and the
   * file channel. `asked` records what the host was asked for.
   */
  runInstalled(files: Record<string, string>, install: Install, main: string, options: { prefetch?: boolean } = {}) {
    this.install = install;
    this.asked = [];
    const nodeModules = Object.fromEntries(Object.entries(install.files).map(([rel, text]) => [rel, Buffer.byteLength(text)]));
    const extra = { installKey: INSTALL_KEY, nodeModules, preload: `/__sandburg/preload/${INSTALL_KEY}/${'b'.repeat(16)}`, prefetch: !!options.prefetch };
    return this.page.evaluate(([f, m, e]) => (window as unknown as { runNode: Function }).runNode(f, m, [], e), [files, main, extra] as const) as Promise<{
      stdout: string;
      stderr: string;
      fatal: string | null;
      exit: number | null;
    }>;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.server?.close();
  }
}
