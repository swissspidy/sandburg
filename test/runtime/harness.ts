/**
 * Minimal harness for the node runtime: serves the worker bundle and the
 * compile endpoint on loopback and runs a program in Chromium. Used by the
 * runtime tests; no Sandburg session involved.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { bundleNodeRuntime } from '../../src/node-runtime/bundle.ts';
import { compileForRuntime, type CompileKind } from '../../src/adapters/node/compile.ts';

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
      if (url.pathname === '/__sandburg/compile') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const out = compileForRuntime(Buffer.concat(chunks).toString(), url.searchParams.get('path') ?? '/x.js', (url.searchParams.get('kind') ?? 'cjs') as CompileKind);
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
