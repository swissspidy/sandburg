/**
 * A Node.js process in the browser: Sandburg's runtime (ADR 0006) in a Web
 * Worker, as the host page sees it. Used by the node adapter (the app is the
 * process) and by the esbuild adapter (the app's backend is the process).
 */
import { AdapterError, type Activity } from '../../host/types.ts';
import type { FileTree } from '../../types.ts';
import type { FromWorker, ToWorker } from '../../node-runtime/messages.ts';
import type { CacheEntry } from '../../node-runtime/cache-tree.ts';
import type { BridgeReply, BridgedRequest } from '../sw-bridge.ts';
import { traceTransfer } from '../../transfer-trace.ts';

/** Whether the host traces transfers (src/transfer-trace.ts): the host page says so. */
const tracing = () => !!(globalThis as { __sandburgTraceTransfers?: boolean }).__sandburgTraceTransfers;

export interface NodeProcessOptions {
  files: FileTree;
  env: Record<string, string>;
  installKey: string | null;
  /** The URL of a preload bundle for the install (see adapters/node/index.ts). */
  preload?: string | null;
  /** The URL of a bundle of project files to start with. */
  filesBundle?: string | null;
  /** What the host compiled for earlier runs of the project (see compile-cache.ts). */
  compileCache?: { key: string; bundle: string | null } | null;
  /** Project directories whose CommonJS files the runtime has compiled as they are written (node-runtime/compile-ahead.ts). */
  compileAhead?: string[];
  nodeModules: Record<string, number> | null;
  /** node_modules installed in the browser: one block of shared memory and its index (see npm/install.ts). */
  pack?: { sab: SharedArrayBuffer; index: Record<string, [number, number]> } | null;
  /** A port to the page's compiler (compile-worker.ts), when the packages were installed in the browser. */
  compilePort?: MessagePort | null;
  log(stream: 'stdout' | 'stderr', line: string): void;
  /** What the program is, for messages ("the app", "the backend"). */
  label?: string;
  /** A runtime worker started earlier, waiting for its init message (see prepare() in browser.ts). */
  worker?: Worker;
  /** Started by a TypeScript runner (tsx, ts-node): `./x.js` imports resolve to `./x.ts`. */
  tsRunner?: boolean;
  /** Node options of the program (`node --conditions=development …`). */
  execArgv?: string[];
}

/** A file of a dev server's cache: text, or binary as base64. */
export type CacheFile = string | { base64: string };

/** A dev server's cache as the runtime read it (readCache): its files [path, size], and their bytes as a bundle if asked. */
export interface CacheSnapshot {
  files: CacheEntry[];
  bundle: ArrayBuffer | null;
}

/**
 * Where the runtime reaches the host (worker script, installed files, compiles). /__sandburg on a
 * sandbox origin; a page may set another (the static demos serve it under their own path).
 */
export function hostBase(): string {
  return globalThis.__sandburgBase ?? '/__sandburg';
}

/** The largest bundle downloaded ahead (prefetchBundle); a larger one fails there and the runtime asks for it. */
const PREFETCH_MAX = 1 << 30;

/**
 * Starts downloading a bundle the runtime reads as it starts (the install's preload bundle, a dev
 * server's cache), while the worker loads: into shared memory, which the runtime waits on instead of
 * requesting the bundle itself (worker.ts, prefetchedBody). Its state (0 downloading, 1 done, 2
 * failed) and length, then the bytes; the memory grows to the bundle's size (its maximum reserves
 * address space only). Null where there is no shared memory.
 */
function prefetchBundle(url: string | null | undefined): SharedArrayBuffer | null {
  if (!url || !globalThis.crossOriginIsolated) return null;
  let sab: SharedArrayBuffer;
  try {
    sab = new SharedArrayBuffer(8, { maxByteLength: 8 + PREFETCH_MAX });
  } catch {
    return null;
  }
  const state = new Int32Array(sab, 0, 2);
  const settle = (status: number, length = 0) => {
    Atomics.store(state, 1, length);
    Atomics.store(state, 0, status);
    Atomics.notify(state, 0);
  };
  const t0 = performance.now();
  void (async () => {
    const res = await fetch(url);
    if (!res.ok || !res.body) return settle(2);
    const declared = Number(res.headers.get('content-length'));
    let length = 0;
    if (declared > 0) sab.grow(8 + declared);
    // Written as it arrives: no copy of the whole body first.
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (8 + length + value.length > sab.byteLength) sab.grow(Math.min(8 + PREFETCH_MAX, Math.max(8 + length + value.length, sab.byteLength * 2)));
      new Uint8Array(sab, 8 + length, value.length).set(value);
      length += value.length;
    }
    settle(1, length);
    traceTransfer({ hop: 'host→page prefetch', what: url, bytes: length, encoding: 'shared', ms: performance.now() - t0 });
  })().catch(() => settle(2));
  return sab;
}

/** How long a server on a port the system picked waits before it may be taken for the app (see 'listening'). */
const EPHEMERAL_PATIENCE_MS = 5_000;

/** How long every process of the program serves a port, with no new port, before pagePort takes a port that sent no HTML. */
const SETTLED_MS = 1000;

/**
 * What the head of an answer to pagePort's probe (GET /) tells: whether it is the page (null: no
 * Content-Type, the body tells), and whether it said it serves something else (notPage: a status
 * of 400 or more, or a Content-Type other than HTML or plain text, as an API's JSON).
 */
export function probeAnswer(status: number, contentType: string | undefined): { page: boolean | null; notPage: boolean } {
  if (status >= 400) return { page: false, notPage: true };
  if (contentType === undefined) return { page: null, notPage: false };
  const html = /html/i.test(contentType);
  return { page: html, notPage: !html && !/^\s*text\/plain/i.test(contentType) };
}

/**
 * Whether pagePort, with every port probed and none the page's, takes the first port now: after
 * `patience` ms without a new port, or SETTLED_MS after the last port or report once no process of
 * the program is still starting (process-tree.ts in the runtime), unless a port said it serves
 * something else (a Content-Type other than HTML or plain text, or a status of 400 or more: an
 * API). A process may serve an API first and its page's dev server seconds later (Vite's
 * createServer); then only a new port, or the patience, ends the wait.
 */
export function pagePortSettled(s: { now: number; lastPort: number; patience: number; starting: number | null; startingSince: number; notPage: boolean }): boolean {
  if (s.now - s.lastPort > s.patience) return true;
  return s.starting === 0 && !s.notPage && s.now - Math.max(s.lastPort, s.startingSince) > SETTLED_MS;
}

/** How much of a body without a Content-Type is read to tell whether it is HTML. */
const SNIFF_BYTES = 512;
const DOCUMENT_STARTS = ['<!doctype html', '<html', '<head', '<body', '<!--'];

/**
 * Whether a body without a Content-Type is HTML (as a browser sniffs it): its first tag is one of a
 * document's, or a comment. null while the bytes so far are only the start of one (a streamed
 * body's first chunk can end inside its first tag).
 */
export function sniffHtml(bytes: Uint8Array): boolean | null {
  const head = new TextDecoder().decode(bytes.subarray(0, SNIFF_BYTES)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (/^<(?:(?:!doctype html|html|head|body)[\s>]|!--)/.test(head)) return true;
  if (bytes.length >= SNIFF_BYTES) return false;
  return DOCUMENT_STARTS.some((start) => start.startsWith(head)) ? null : false;
}

/** Whether a whole body without a Content-Type is HTML (see sniffHtml). */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  return sniffHtml(bytes) === true;
}

export class NodeProcess {
  /** Ports the program's HTTP servers listen on, in the order they started. */
  readonly ports: number[] = [];
  /** How many of the program's processes are still starting (process-tree.ts in the runtime); null until it reports. */
  private starting: number | null = null;
  private startingSince = 0;
  /** Commands of the dev script that exited with an error (a backend that crashed, say). */
  readonly failedCommands: { command: string; code: number; stderr: string }[] = [];
  failure: Error | null = null;
  exitCode: number | null = null;
  private worker: Worker;
  private terminated = false;
  private crashes = new BroadcastChannel('sandburg-wasm-thread-crash');
  private ready = false;
  private waiters = new Set<() => void>();
  private pending = new Map<number, BridgeReply>();
  /** When each pending request was sent (see activity()). */
  private sent = new Map<number, number>();
  private lastRequest = performance.now();
  private sockets = new Map<number, MessagePort>();
  private nextId = 1;
  private label: string;
  private partial = { stdout: '', stderr: '' };
  private trees = new Map<number, (files: Record<string, CacheFile>) => void>();
  private projectReadsAnswers = new Map<number, (answer: { reads: string[] | null; installed: boolean[] }) => void>();
  private caches = new Map<number, (cache: CacheSnapshot | null) => void>();
  /** When the page last sent the runtime a request or heard from it (see activity()). */
  private lastActivity = performance.now();

  constructor(opts: NodeProcessOptions) {
    this.label = opts.label ?? 'the app';
    const base = hostBase();
    this.worker = opts.worker ?? new Worker(`${base}/node-worker.js`);
    const prefetched: Record<string, SharedArrayBuffer> = {};
    for (const url of [opts.preload, opts.filesBundle]) {
      const sab = prefetchBundle(url);
      if (url && sab) prefetched[url] = sab;
    }
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data, opts);
    this.worker.onerror = (e) => this.fail(new AdapterError('INTERNAL', `runtime worker error: ${e.message}`));
    // A WebAssembly thread of the app's process that crashed while its parent was blocked (it
    // reports here directly; WASM_CRASH_CHANNEL in threads.ts).
    this.crashes.onmessage = (e: MessageEvent<{ message: string; stack?: string }>) =>
      this.fail(new AdapterError('INTERNAL', [e.data.message, ...(e.data.stack ?? '').split('\n').slice(1)].join('\n').trim()));
    this.send(
      { type: 'init', cwd: '/app', env: opts.env, files: opts.files, installKey: opts.installKey, preload: opts.preload ?? null, filesBundle: opts.filesBundle ?? null, prefetched, compileCache: opts.compileCache ?? null, ...(opts.compileAhead?.length ? { compileAhead: opts.compileAhead } : {}), nodeModules: opts.nodeModules, pack: opts.pack ?? null, compilePort: opts.compilePort ?? null, base, tsRunner: opts.tsRunner, execArgv: opts.execArgv, ...(tracing() ? { trace: true } : {}) },
      opts.compilePort ? [opts.compilePort] : [],
    );
  }

  /** To the runtime: only a message it takes compiles. */
  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  /** Resolves when the runtime has loaded. */
  started(): Promise<void> {
    return this.until(() => this.ready);
  }

  /** `track`: project directories whose changes the runtime notes from now on (see readCache's ifChanged). */
  run(main: string, argv: string[] = [], track?: string[]): void {
    this.send({ type: 'run', main, argv, track });
  }

  /** Resolves with the first listening port (or `port`, once it listens). Rejects if the program crashes or exits first. */
  async listening(port?: number): Promise<number> {
    await this.until(() => (port === undefined ? this.ports.length > 0 : this.ports.includes(port)));
    return port ?? this.ports[0];
  }

  /**
   * The port whose server serves the app's page: of the ports the program listens on, the first to
   * answer GET / with HTML (a dev script may start an API server before or beside the page's). If
   * none has, the first port: once no other server is coming (see pagePortSettled); else after
   * `patience` ms without a new port. The wait is long because some dev servers listen only once
   * they have compiled the app (ng serve, 20-40 s here), and an API server that started first must
   * not be taken for the app.
   */
  async pagePort(patience = 60_000): Promise<number> {
    await this.listening();
    const probed = new Set<number>();
    let found: number | null = null;
    let settled = 0;
    let lastPort = Date.now();
    /** Whether a port said it serves something else (see pagePortSettled). */
    let notPage = false;
    const probe = (port: number) => {
      probed.add(port);
      lastPort = Date.now();
      const channel = new MessageChannel();
      const done = (page: boolean) => {
        if (page && found === null) found = port;
        settled++;
        channel.port1.close();
        for (const w of this.waiters) w();
      };
      // An answer without a Content-Type (a hand-written http server) is a page if its body starts as HTML does.
      // Its first bytes are kept until they tell (a chunk can end inside the first tag), or it ends.
      let sniffed: Uint8Array | null = null;
      channel.port1.onmessage = (e) => {
        const m = e.data as { type: string; status?: number; headers?: [string, string][]; body?: ArrayBuffer; chunk?: Uint8Array };
        if (sniffed) {
          if (m.type !== 'chunk') return done(m.type === 'end' && looksLikeHtml(sniffed));
          const joined = new Uint8Array(Math.min(sniffed.length + m.chunk!.length, SNIFF_BYTES));
          joined.set(sniffed);
          joined.set(m.chunk!.subarray(0, joined.length - sniffed.length), sniffed.length);
          sniffed = joined;
          const page = sniffHtml(sniffed);
          return page === null ? undefined : done(page);
        }
        if (m.type === 'start' || m.type === 'full' || m.type === 'error') {
          const type = m.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
          if (m.type === 'error') return done(false);
          const answer = probeAnswer(m.status!, type);
          if (answer.notPage) notPage = true;
          if (answer.page !== null) return done(answer.page);
          if (m.type === 'full') return done(!!m.body && looksLikeHtml(new Uint8Array(m.body)));
          sniffed = new Uint8Array(0);
        }
      };
      this.request(port, { method: 'GET', url: '/', headers: [['accept', 'text/html']], body: null }, channel.port2);
    };
    const tick = setInterval(() => {
      for (const w of this.waiters) w();
    }, 250);
    try {
      await this.until(() => {
        for (const port of this.ports) if (!probed.has(port)) probe(port);
        if (found !== null || settled !== probed.size) return found !== null;
        return pagePortSettled({ now: Date.now(), lastPort, patience, starting: this.starting, startingSince: this.startingSince, notPage });
      });
    } finally {
      clearInterval(tick);
    }
    return found ?? this.ports[0];
  }

  /** The port of the app's page (its dev server), once known: the origin its requests come from (localOrigin). */
  appPort: number | null = null;

  /**
   * The page's origin as a browser on the developer's machine would send it. Dev servers check Host
   * and Origin against localhost (Vite's allowedHosts, Next.js' allowedDevOrigins, Angular's
   * allowedHosts); the page's real origin (a sandbox, or a site such as GitHub Pages) is not one.
   */
  private localOrigin(port: number): string {
    return `http://localhost:${this.appPort ?? port}`;
  }

  /** An absolute URL of one of the program's servers (http://localhost:<port>/…) as a path on the page's origin. */
  private unlocalize(url: string): string {
    const m = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(?=[/?#]|$)/.exec(url);
    return m && this.ports.includes(Number(m[1] ?? 80)) ? url.slice(m[0].length) || '/' : url;
  }

  /** Origin or Referer from the page, rewritten to localOrigin. */
  private localize(value: string, port: number): string {
    return value === location.origin || value.startsWith(location.origin + '/') ? this.localOrigin(port) + value.slice(location.origin.length) : value;
  }

  /** Forwards a request from the service worker to the server on `port`; the response streams back over `reply`. */
  request(port: number, request: BridgedRequest, reply: BridgeReply): void {
    // A program that only exited may leave child processes serving (see 'exit'); one that failed (also
    // after it exited: the page's compiler, a WebAssembly thread) may never answer.
    const gone = this.terminated ? `${this.label} stopped` : this.failure ? `${this.label} crashed: ${this.failure.message.split('\n')[0]}` : null;
    if (gone) {
      reply.postMessage({ type: 'error', message: gone });
      reply.close();
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, reply);
    this.lastActivity = this.lastRequest = performance.now();
    this.sent.set(id, this.lastRequest);
    // No Accept-Encoding: the browser does not decode compressed bodies of service-worker Responses.
    const headers: [string, string][] = request.headers
      .filter(([k]) => !/^(cookie|accept-encoding|host)$/i.test(k))
      .map(([k, v]) => (/^(origin|referer)$/i.test(k) ? [k, this.localize(v, port)] : [k, v]));
    if (document.cookie) headers.push(['cookie', document.cookie]);
    // The server is at localhost:<port>, as on the developer's machine (a service worker's request carries no Host).
    headers.push(['host', `localhost:${port}`]);
    this.send({ type: 'request', id, port, method: request.method, url: request.url, headers, body: request.body }, request.body ? [request.body] : []);
  }

  /**
   * Connects an app frame's WebSocket (ws-shim.js) to the server on `port`: the port carries
   * send/close from the page and open/message/close back.
   */
  connectWebSocket(port: number, url: string, protocols: string[], channel: MessagePort): void {
    const id = this.nextId++;
    this.sockets.set(id, channel);
    const target = new URL(url);
    const headers: [string, string][] = [
      ['host', `localhost:${port}`],
      ['origin', this.localOrigin(port)],
      ['user-agent', navigator.userAgent],
    ];
    if (document.cookie) headers.push(['cookie', document.cookie]);
    channel.onmessage = (e) => {
      const m = e.data as { type: 'send'; data: string | ArrayBuffer } | { type: 'close'; code?: number; reason?: string };
      if (m.type === 'send') this.send({ type: 'ws-send', id, data: m.data }, typeof m.data === 'string' ? [] : [m.data]);
      else this.send({ type: 'ws-close', id, code: m.code, reason: m.reason });
    };
    this.send({ type: 'ws-open', id, port, url: target.pathname + target.search, headers, protocols });
  }

  /** Writes a project file in the running program's file system (dev servers' watchers pick it up). */
  writeFile(path: string, content: string): void {
    this.send({ type: 'write-file', path, content });
  }

  /** The project's files whose path matches `match` (a regular expression's source), outside node_modules and dot directories, as base64. */
  readTree(match: string): Promise<Record<string, CacheFile>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.trees.set(id, resolve);
      this.send({ type: 'read-tree', id, match });
    });
  }

  /**
   * The project's files the runtime's processes have read (null when they are not recorded), and
   * whether each package is installed where its file imports it from (see Vfs.trackReads, installedFrom);
   * null when the runtime does not answer within `timeoutMs` (it is not waited for after that).
   */
  projectReads(packages: { name: string; from: string }[], timeoutMs = 3_000): Promise<{ reads: string[] | null; installed: boolean[] } | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.projectReadsAnswers.delete(id);
        resolve(null);
      }, timeoutMs);
      this.projectReadsAnswers.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.send({ type: 'project-reads', id, packages });
    });
  }

  /** How many project-reads answers are still awaited (tests). */
  get projectReadsWaiting(): number {
    return this.projectReadsAnswers.size;
  }

  /**
   * A dev server's cache under project directories (see node-runtime/cache-tree.ts): its files, and
   * with `bytes` their bytes as a bundle; with `ifChanged`, null when no file under the directories
   * run() tracks changed since the program started.
   */
  readCache(dirs: string[], { bytes, ifChanged = false }: { bytes: boolean; ifChanged?: boolean }): Promise<CacheSnapshot | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.caches.set(id, resolve);
      this.send({ type: 'read-cache', id, dirs, bytes, ifChanged });
    });
  }

  /** Stops the runtime: requests still waiting, and any sent after, are answered with an error. */
  terminate(): void {
    this.terminated = true;
    this.crashes.close();
    this.worker.terminate();
    this.settlePending(`${this.label} stopped`);
  }

  /**
   * Whether the app's servers are working: requests still being answered, and how long since the
   * runtime last said anything (a response, a log line). Checks stop waiting for an assertion that
   * keeps failing once the runtime is idle: nothing is still coming.
   */
  activity(): Activity {
    const now = performance.now();
    let newestMs = Infinity;
    for (const t of this.sent.values()) newestMs = Math.min(newestMs, now - t);
    return {
      inflight: this.pending.size,
      idleMs: Math.round(now - this.lastActivity),
      sinceRequestMs: Math.round(now - this.lastRequest),
      newestInflightMs: this.pending.size ? Math.round(newestMs) : null,
    };
  }

  private onMessage(m: FromWorker, opts: NodeProcessOptions) {
    this.lastActivity = performance.now();
    switch (m.type) {
      case 'log': {
        // Whole lines: a program may write a line in pieces (concurrently writes its "[name] " prefix first).
        const text = this.partial[m.stream] + m.text;
        const end = text.lastIndexOf('\n');
        this.partial[m.stream] = text.slice(end + 1);
        if (end >= 0) for (const line of text.slice(0, end).split('\n')) opts.log(m.stream, line);
        if (this.partial[m.stream].length > 65536) {
          opts.log(m.stream, this.partial[m.stream]);
          this.partial[m.stream] = '';
        }
        break;
      }
      case 'ready':
        this.ready = true;
        break;
      case 'listening':
        // TCP ports only (the runtime keeps servers on local sockets to itself).
        if (typeof m.port !== 'number') break;
        // A port the system picked (port 0) is a tool's probe or internal server, gone by the time the
        // page asks it for anything (@nuxt/cli 4 probes before it starts): the app's only if nothing
        // else listens a while later.
        if (m.ephemeral) {
          const port = m.port;
          setTimeout(() => {
            if (!this.ports.length) {
              this.ports.push(port);
              for (const w of this.waiters) w();
            }
          }, EPHEMERAL_PATIENCE_MS);
        } else if (!this.ports.includes(m.port)) this.ports.push(m.port);
        break;
      case 'cache':
        if (tracing() && m.bundle) traceTransfer({ hop: 'runtime→page postMessage', what: 'cache', bytes: m.bundle.byteLength, encoding: 'binary', ms: 0 });
        this.caches.get(m.id)?.(m.unchanged ? null : { files: m.files, bundle: m.bundle });
        this.caches.delete(m.id);
        break;
      case 'tree':
        if (tracing()) traceTransfer({ hop: 'runtime→page postMessage', what: 'tree', bytes: Object.values(m.files).reduce((n, f) => n + f.base64.length, 0), encoding: 'base64', ms: 0 });
        this.trees.get(m.id)?.(m.files);
        this.trees.delete(m.id);
        break;
      case 'project-reads':
        this.projectReadsAnswers.get(m.id)?.({ reads: m.reads, installed: m.installed });
        this.projectReadsAnswers.delete(m.id);
        break;
      case 'process-exit':
        this.failedCommands.push({ command: m.command, code: m.code, stderr: m.stderr });
        break;
      case 'starting':
        this.starting = m.count;
        this.startingSince = Date.now();
        for (const w of this.waiters) w();
        break;
      case 'fatal':
        // The runtime could not load one of its own parts, or a WebAssembly thread crashed:
        // not the app's code (classify matches the message).
        if (m.trap) this.fail(new AdapterError('INTERNAL', [m.message, ...(m.stack ?? '').split('\n').slice(1)].join('\n').trim()));
        else this.fail(new AdapterError(m.message.startsWith('runtime asset failed to load') ? 'INTERNAL' : 'APP', m.stack ?? m.message));
        break;
      case 'exit':
        // Not every request is gone with it: servers of child processes it started keep answering
        // (the runtime answers those of its own servers with an error).
        this.exitCode = m.code;
        if (!this.ports.length) this.fail(new AdapterError('APP', `${this.label} exited with code ${m.code} before it started listening`));
        break;
      case 'response-start':
      case 'response-full': {
        // Only for a request of the page's: not one the page no longer waits for (nor another runtime's).
        const reply = this.pending.get(m.id);
        if (!reply) break;
        for (const [k, v] of m.headers) if (k.toLowerCase() === 'set-cookie') applyCookie(v);
        // A redirect to the server's own address (built from Host, now localhost) stays on the page's origin.
        const headers = m.headers.map(([k, v]): [string, string] => [k, k.toLowerCase() === 'location' ? this.unlocalize(v) : v]);
        if (m.type === 'response-start') {
          reply.postMessage({ type: 'start', status: m.status, statusText: m.statusText, headers });
          break;
        }
        // The whole response at once (see request() in worker.ts).
        reply.postMessage({ type: 'full', status: m.status, statusText: m.statusText, headers, body: m.body }, [m.body]);
        reply.close();
        this.pending.delete(m.id);
        this.sent.delete(m.id);
        break;
      }
      case 'ws-accept':
        this.sockets.get(m.id)?.postMessage({ type: 'open', protocol: m.protocol, extensions: m.extensions });
        break;
      case 'ws-message':
        this.sockets.get(m.id)?.postMessage({ type: 'message', data: m.data }, typeof m.data === 'string' ? [] : [m.data]);
        break;
      case 'ws-reject':
        opts.log('stderr', `WebSocket connection refused (${m.status}): ${m.message}`);
        this.sockets.get(m.id)?.postMessage({ type: 'close', code: 1006, reason: '', wasClean: false, error: true });
        this.sockets.delete(m.id);
        break;
      case 'ws-closed':
        this.sockets.get(m.id)?.postMessage({ type: 'close', code: m.code, reason: m.reason, wasClean: m.wasClean });
        this.sockets.delete(m.id);
        break;
      case 'response-chunk':
        this.pending.get(m.id)?.postMessage({ type: 'chunk', chunk: m.chunk }, [m.chunk.buffer]);
        break;
      case 'response-end':
        this.pending.get(m.id)?.postMessage({ type: 'end' });
        this.pending.get(m.id)?.close();
        this.pending.delete(m.id);
        this.sent.delete(m.id);
        break;
      case 'response-error':
        this.pending.get(m.id)?.postMessage({ type: 'error', message: m.message });
        this.pending.get(m.id)?.close();
        this.pending.delete(m.id);
        this.sent.delete(m.id);
        break;
      // The page's runtime is started with init right away, and has no parent for process.send().
      case 'booted':
      case 'message':
        break;
    }
    for (const w of this.waiters) w();
  }

  /** Rejects when the program fails, at any point (the page waits on it while the app loads). */
  failed(): Promise<never> {
    return this.until(() => false) as Promise<never>;
  }

  /** Ends the wait for the program (listening(), pagePort()) with an error. */
  fail(e: Error) {
    this.failure ??= e;
    this.settlePending(`${this.label} crashed: ${e.message.split('\n')[0]}`);
    for (const w of this.waiters) w();
  }

  /** Answers the requests still waiting with an error: the runtime that would have answered them is gone. */
  private settlePending(message: string) {
    for (const reply of this.pending.values()) {
      reply.postMessage({ type: 'error', message });
      reply.close();
    }
    this.pending.clear();
    this.sent.clear();
  }

  private until(cond: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (cond()) {
          this.waiters.delete(check);
          resolve();
        } else if (this.failure) {
          this.waiters.delete(check);
          reject(this.failure);
        }
      };
      this.waiters.add(check);
      check();
    });
  }
}

/** Which port of the runtime an app WebSocket URL goes to: same-origin → `samePort`, localhost:<port> → that port. */
export function webSocketPort(url: string, ports: number[], samePort: (path: string) => number | null): number | null {
  const u = new URL(url);
  if (u.host === location.host) return samePort(u.pathname + u.search);
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(u.hostname)) {
    const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
    return ports.includes(port) ? port : null;
  }
  return null;
}

/** Lets app pages open WebSockets through the host page (ws-shim.js calls window.top.__sandburgWs). */
export function exposeWebSockets(route: (url: string) => { proc: NodeProcess; port: number } | null): void {
  window.__sandburgWs = (url: string, protocols: string[], channel: MessagePort) => {
    const target = route(url);
    if (!target) return false;
    target.proc.connectWebSocket(target.port, url, protocols, channel);
    return true;
  };
}

/** Applies a Set-Cookie header to the sandbox origin (a service worker cannot). HttpOnly cannot be honored. */
function applyCookie(header: string) {
  const [pair, ...attrs] = header.split(';');
  const kept = attrs.map((a) => a.trim()).filter((a) => !/^(httponly|secure)$/i.test(a));
  document.cookie = [pair.trim(), ...kept].join('; ');
}
