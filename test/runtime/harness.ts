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
import { RUNTIME_MODULE, runtimeBootstrap } from '../../src/node-runtime/runtime-module.ts';
import { createHash } from 'node:crypto';
import { acceptFileChannel } from '../../src/orchestrator/host-socket.ts';
import type { HostRequest } from '../../src/types.ts';
import { compiled, compileForRuntime, projectHasTopLevelAwait, type CompileKind } from '../../src/adapters/node/compile.ts';
import { nativeTransform } from '../../src/adapters/node/native-transform.ts';

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
  const out = { stdout: '', stderr: '', responses: [], whole: [], fatal: null, exit: null, listening: [], ends: [], stray: [] };
  const bodies = new Map();
  let pending = requests.length;
  const finish = () => { w.terminate(); resolve(out); };
  // The run is over (it exited, or each request has its answer); with linger, kept that long to see what comes after.
  let over = false;
  const done = () => {
    if (over) return;
    over = true;
    if (extra.linger) setTimeout(finish, extra.linger);
    else finish();
  };
  // The run the harness is waiting on (see RuntimeHarness.until): its output so far, and its end.
  window.current = { out, finish };
  w.onmessage = (e) => {
    const m = e.data;
    // A response for a request the page did not make (or of the runtimes': their ids are negative).
    if (m.type.startsWith('response-') && !(m.id >= 0 && m.id < requests.length)) return void out.stray.push([m.type, m.id]);
    if (m.type === 'ready') w.postMessage({ type: 'run', main });
    else if (m.type === 'log') out[m.stream] += m.text;
    else if (m.type === 'fatal') { out.fatal = m.stack || m.message; finish(); }
    else if (m.type === 'exit') {
      out.ends.push(['exit', m.code]);
      out.exit = m.code;
      // With reads: the project files the runtime records as read (worker.ts, project-reads), asked once the program is over.
      if (!requests.length) extra.reads ? w.postMessage({ type: 'project-reads', id: 1, packages: [] }) : done();
    }
    else if (m.type === 'project-reads') { out.reads = m.reads; done(); }
    else if (m.type === 'listening') {
      // The ports the page was told of.
      out.listening.push(m.port);
      requests.forEach((r, i) => w.postMessage({ type: 'request', id: i, port: m.port, method: r.method || 'GET', url: r.url, headers: [['host', 'localhost']], body: null }));
    }
    else if (m.type === 'response-start') bodies.set(m.id, { status: m.status, headers: m.headers, chunks: [] });
    else if (m.type === 'response-chunk') bodies.get(m.id).chunks.push(new TextDecoder().decode(m.chunk));
    else if (m.type === 'response-full') {
      // A response that ended in the task that started it, in one message (see request() in worker.ts).
      const body = new TextDecoder().decode(m.body);
      out.whole.push(m.id);
      out.ends.push([m.type, m.id]);
      out.responses[m.id] = { status: m.status, body, chunks: body ? 1 : 0 };
      if (--pending === 0) done();
    }
    else if (m.type === 'response-end' || m.type === 'response-error') {
      const b = bodies.get(m.id) || { status: 0, chunks: [m.message] };
      out.ends.push([m.type, m.id]);
      out.responses[m.id] = { status: b.status, body: b.chunks.join(''), chunks: b.chunks.length };
      if (--pending === 0) done();
    }
  };
  w.onerror = (e) => { out.fatal = 'worker error: ' + e.message; finish(); };
  const init = { type: 'init', cwd: '/app', env: {}, files, installKey: null, nodeModules: null, base: '/__sandburg', ...extra };
  if (extra.prefetch) init.prefetched = { [extra.preload]: window.prefetch(extra.preload) };
  // As the page does at a run's mount (adapters/node/browser.ts): the runtime starts its spares, then waits for init.
  // A program ends when it exits (or, with requests, once each has its response), or when the harness
  // ends it (until); the backstop only ends one that hangs.
  const start = () => {
    w.postMessage(init);
    if (!requests.length) setTimeout(finish, 30_000);
  };
  // As the page does when it prepares a runtime as it loads (adapters/node/browser.ts): the runtime starts its file helper.
  if (extra.prepare) w.postMessage({ type: 'prepare', helperDelay: extra.helperDelay });
  if (extra.spares) {
    w.postMessage({ type: 'spares' });
    setTimeout(start, extra.spares);
  } else if (extra.prepare) setTimeout(start, extra.prepare);
  else start();
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
    else if (m.type === 'exit') out.events.push(['exit', m.code]);
  };
  w.postMessage({ type: 'init', cwd: '/app', env: {}, files, installKey: null, nodeModules: null, base: '/__sandburg' });
  setTimeout(finish, 3000);
});
</script>`;

/** An install the harness serves (see runInstalled): node_modules files by path, and which of them its preload bundle has. */
interface Install {
  files: Record<string, string>;
  bundled: string[];
  /** Transformed files the host pushes with a transformed file asked for with ?ahead=1 (see pushAhead). */
  pushes?: Record<string, string[]>;
  /** Files the preload bundle only names (a negative size): the runtime downloads them on the side (downloadOnSide). */
  side?: string[];
}
export const INSTALL_KEY = 'a'.repeat(24);

/** A transform the harness answers with how it was asked ("ws" over the file channel, else "http"), not recorded in `asked`. */
const PROBE = '/* sandburg harness: which way? */';

/**
 * For a program: `channelOpen()` resolves once the runtime asks the host over its file channel (each
 * request after it does too), as a probe of the runtime's esbuild hook finds out. With `holdChannel`,
 * the harness opens the channel only once a program asked this.
 */
export const CHANNEL_OPEN = `const channelOpen = async () => {
  for (;;) {
    const r = await globalThis[Symbol.for('sandburg.esbuildTransform')]('0.25.12', ${JSON.stringify(PROBE)}, {});
    if (r && r.code.includes('"ws"')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};`;

/** What a running program has printed and what the host was asked for, for RuntimeHarness.until. */
type RunState = { stdout: string; asked: string[] };

/** The compile route's answer (as the node adapter's, without the compile cache). */
function compileAnswer(code: Buffer, query: URLSearchParams): { status: number; body: string } {
  try {
    return { status: 200, body: compileForRuntime(code.toString(), query.get('path') ?? '/x.js', (query.get('kind') ?? 'cjs') as CompileKind, { asyncModules: query.get('async') === '1' }) };
  } catch (e) {
    return { status: 400, body: String((e as Error).message) };
  }
}

export class RuntimeHarness {
  private server!: Server;
  private browser!: Browser;
  page!: Page;
  private install: Install = { files: {}, bundled: [] };
  /** What the host was asked for: `http <path>` or `ws <path>`. */
  asked: string[] = [];
  /** Answer /__sandburg/node-spare.js with a 404, as a host that does not serve it. */
  noSpareScript = false;
  /** Answer /__sandburg/node-worker.js with the runtime's script itself, as a static deployment does (scripts/pages/build.ts). */
  classicRuntime = false;
  /** File channels waiting to be accepted, while the harness holds them (runInstalled's holdChannel); null when it does not. */
  private held: (() => void)[] | null = null;
  /** Requests to /__test/hold-closed waiting for more of /__test/hold's responses to close. */
  private holdWaiters = new Set<() => void>();

  private release(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const accept of held) accept();
  }

  /** An esbuild transform's answer; a probe (CHANNEL_OPEN) is answered with the way it came, and opens a held channel. */
  private async transform(r: Omit<HostRequest, 'sandbox'>, via: 'ws' | 'http') {
    const body = await r.body();
    const [options, input] = JSON.parse(body.toString()) as [unknown, unknown];
    if (input !== PROBE) {
      this.asked.push(`${via} ${r.path}?${r.query.toString()}`);
      return nativeTransform({ ...r, sandbox: 'harness', body: async () => body });
    }
    if (via === 'http') this.release();
    return nativeTransform({ ...r, sandbox: 'harness', body: async () => Buffer.from(JSON.stringify([options, `export default ${JSON.stringify(via)};`])) });
  }

  /** The host's answer for an install's file or its preload bundle, as the node adapter serves them. */
  private installed(path: string): Buffer | null {
    const m = /^\/__sandburg\/nm\/[0-9a-f]{24}\/(f|t)\/(.+)$/.exec(path);
    if (m) {
      const text = this.install.files[decodeURIComponent(m[2])];
      return text === undefined ? null : Buffer.from(text);
    }
    if (!path.startsWith('/__sandburg/preload/')) return null;
    const files = this.install.bundled.flatMap((rel) => ['f', 't'].map((mode) => [mode, rel, Buffer.from(this.install.files[rel])] as const));
    const side = (this.install.side ?? []).map((rel) => ['f', rel, -Buffer.byteLength(this.install.files[rel])]);
    const header = Buffer.from(JSON.stringify([...files.map(([mode, rel, bytes]) => [mode, rel, bytes.length]), ...side]));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    return Buffer.concat([length, header, ...files.map((f) => f[2])]);
  }

  /** A read-ahead answer, as the node adapter's (readAhead): the raw file and those after it in its directory, up to `until`. */
  private ahead(path: string, until: string | null): Buffer | null {
    const rel = decodeURIComponent(path.replace(/^\/__sandburg\/nm\/[0-9a-f]{24}\/f\//, ''));
    const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
    const names = Object.keys(this.install.files).filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/')).map((p) => p.slice(dir.length)).sort();
    const after = names.slice(names.indexOf(rel.slice(dir.length)) + 1).filter((n) => until === null || n < until);
    if (!after.length) return null;
    const files = [rel, ...after.map((n) => dir + n)].map((p) => [p, Buffer.from(this.install.files[p])] as const);
    const header = Buffer.from(JSON.stringify(files.map(([p, bytes]) => ['f', p, bytes.length])));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    return Buffer.concat([length, header, ...files.map((f) => f[1])]);
  }

  /** A push answer: the transformed file and the ones `pushes` lists for it. */
  private pushed(path: string): Buffer | null {
    const rel = decodeURIComponent(path.replace(/^\/__sandburg\/nm\/[0-9a-f]{24}\/t\//, ''));
    const more = this.install.pushes?.[rel];
    if (!more?.length) return null;
    const files = [rel, ...more].map((p) => [p, Buffer.from(this.install.files[p])] as const);
    const header = Buffer.from(JSON.stringify(files.map(([p, bytes]) => ['t', p, bytes.length])));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    return Buffer.concat([length, header, ...files.map((f) => f[1])]);
  }

  async open(): Promise<void> {
    const js = await bundleNodeRuntime();
    // As the host serves it: a classic script that imports the runtime's module by its digest (runtime-module.ts).
    const digest = createHash('sha256').update(js).digest('hex');
    // oxlint-disable-next-line typescript/no-misused-promises -- a test server: a failed request fails its test
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
        return res.end(url.pathname.endsWith('spare.js') ? SPARE_SCRIPT : this.classicRuntime ? js : runtimeBootstrap(digest));
      }
      if (RUNTIME_MODULE.exec(url.pathname)?.[1] === digest) {
        this.asked.push(`http ${url.pathname}`);
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(js);
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
      // A response from another origin (fetch.localhost:<port>), for a program's http.get that goes through fetch().
      if (url.pathname === '/__test/remote') {
        res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
        return res.end('remote');
      }
      // A response that starts and is never ended: `asked` says when the client went away.
      if (url.pathname === '/__test/hold') {
        res.on('close', () => {
          this.asked.push('hold closed');
          for (const waiter of [...this.holdWaiters]) waiter();
        });
        res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
        return void res.write('a');
      }
      // How many of those this run's client went away from, once it is `count` (or after 10 s): for a
      // program to wait, while it runs, for this side to have seen its connections close.
      if (url.pathname === '/__test/hold-closed') {
        const count = Number(url.searchParams.get('count'));
        if (!Number.isInteger(count) || count < 0) {
          res.writeHead(400, { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
          return res.end('count must be a whole number');
        }
        const closed = () => this.asked.filter((a) => a === 'hold closed').length;
        const answer = () => {
          this.holdWaiters.delete(check);
          clearTimeout(timer);
          res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
          res.end(String(closed()));
        };
        const check = () => void (closed() >= count && answer());
        const timer = setTimeout(answer, 10_000);
        this.holdWaiters.add(check);
        // Its client went away: nothing to answer.
        res.on('close', () => {
          this.holdWaiters.delete(check);
          clearTimeout(timer);
        });
        return check();
      }
      if (url.pathname === '/__sandburg/tla-scan') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ topLevelAwait: projectHasTopLevelAwait(JSON.parse(Buffer.concat(chunks).toString())) }));
      }
      if (url.pathname === '/__sandburg/esbuild-transform') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const out = await this.transform({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body: async () => Buffer.concat(chunks) }, 'http');
        res.writeHead(out.status, out.headers);
        return res.end(out.body);
      }
      const known = /^\/__sandburg\/compiled\/([0-9a-f]{64})$/.exec(url.pathname);
      if (known) {
        this.asked.push(`http ${url.pathname}`);
        const out = compiled(known[1]);
        res.writeHead(out === undefined ? 404 : 200, { 'content-type': 'text/javascript' });
        return res.end(out ?? 'not found');
      }
      if (url.pathname === '/__sandburg/compile') {
        this.asked.push(`http POST ${url.pathname}?path=${url.searchParams.get('path')}`);
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const out = compileAnswer(Buffer.concat(chunks), url.searchParams);
        res.writeHead(out.status, { 'content-type': 'text/javascript' });
        return res.end(out.body);
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      res.end(PAGE);
    });
    this.server.on('upgrade', (req, socket) => {
      const origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
      const accept = () => acceptFileChannel(req, socket, origin, async (r: HostRequest) => {
        if (r.path === '/__sandburg/esbuild-transform') return this.transform(r, 'ws');
        const query = r.query.toString();
        this.asked.push(`ws ${r.path}${query ? `?${query}` : ''}`);
        if (r.query.get('used') === '1') return { status: 204, body: '' };
        if (r.path === '/__sandburg/compile') return compileAnswer(await r.body(), r.query);
        const body = this.installed(r.path);
        const ahead = body && r.query.get('ahead') === '1' ? (r.path.includes('/t/') ? this.pushed(r.path) : this.ahead(r.path, r.query.get('until'))) : null;
        return ahead ? { status: 207, body: ahead } : body ? { status: 200, body } : null;
      });
      if (this.held) this.held.push(accept);
      else accept();
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

  /**
   * Ends the run in progress once `done` holds for what it printed and asked for (looked at every
   * 25 ms): for a program that does not exit (a server, a thread that stays). The run's result.
   */
  private async until<T>(run: Promise<T>, done?: (state: RunState) => boolean): Promise<T> {
    if (!done) return run;
    let over = false;
    const end = () => (over = true);
    run.then(end, end);
    while (!over) {
      const stdout = await this.page.evaluate(() => (window as unknown as { current?: { out: { stdout: string } } }).current?.out.stdout ?? '');
      if (done({ stdout, asked: this.asked })) {
        await this.page.evaluate(() => (window as unknown as { current?: { finish(): void } }).current?.finish());
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return run;
  }

  /** The port the harness serves on (127.0.0.1, and *.localhost for another origin). */
  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  run(files: Record<string, string>, main: string, requests: { url: string; method?: string }[] = [], execArgv?: string[], options: { spares?: number; until?: (state: RunState) => boolean; /** Ms the run is kept once it is over, for what comes after. */ linger?: number; /** The program's environment. */ env?: Record<string, string>; /** As runInstalled's. */ prepare?: number; helperDelay?: number; /** Ask, once the program exits, which project files the runtime records as read (`reads`). */ reads?: boolean } = {}) {
    const { until, ...rest } = options;
    this.asked = [];
    this.release();
    return this.until(this.page.evaluate(([f, m, r, a]) => (window as unknown as { runNode: Function }).runNode(f, m, r, a), [files, main, requests, { ...(execArgv ? { execArgv } : {}), ...rest }] as const) as Promise<{
      stdout: string;
      stderr: string;
      fatal: string | null;
      exit: number | null;
      responses: { status: number; body: string; chunks: number }[];
      /** The ids of the requests whose response came in one message (response-full). */
      whole: number[];
      listening: (number | string)[];
      /** Each message that ended a request ([type, id]) or the program (['exit', code]), in order. */
      ends: [string, number][];
      /** The responses for requests the page did not make ([type, id]). */
      stray: [string, number][];
      /** With `reads`: the project files the runtime recorded as read (relative to /app). */
      reads?: string[] | null;
    }>, until);
  }

  /**
   * Runs a program with an install: node_modules files the runtime reads from the host, a preload
   * bundle of `bundled` (downloaded by the page as it starts the runtime if `prefetch`), and the
   * file channel (with `holdChannel`, opened only once the program asks for it: see CHANNEL_OPEN).
   * `prepare`: the page prepares the runtime that long before its init message, as a host page does.
   * `helperDelay`: its file helper then spins that long before it handles a message (one slow to start).
   * `asked` records what the host was asked for.
   */
  runInstalled(files: Record<string, string>, install: Install, main: string, options: { prefetch?: boolean; compileAhead?: string[]; prepare?: number; helperDelay?: number; holdChannel?: boolean; until?: (state: RunState) => boolean } = {}) {
    this.install = install;
    this.asked = [];
    this.release();
    if (options.holdChannel) this.held = [];
    const nodeModules = Object.fromEntries(Object.entries(install.files).map(([rel, text]) => [rel, Buffer.byteLength(text)]));
    const extra = { installKey: INSTALL_KEY, nodeModules, preload: `/__sandburg/preload/${INSTALL_KEY}/${'b'.repeat(16)}`, prefetch: !!options.prefetch, ...(options.compileAhead ? { compileAhead: options.compileAhead } : {}), ...(options.prepare ? { prepare: options.prepare } : {}), ...(options.helperDelay ? { helperDelay: options.helperDelay } : {}) };
    return this.until(this.page.evaluate(([f, m, e]) => (window as unknown as { runNode: Function }).runNode(f, m, [], e), [files, main, extra] as const) as Promise<{
      stdout: string;
      stderr: string;
      fatal: string | null;
      exit: number | null;
    }>, options.until);
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.server?.close();
  }
}
