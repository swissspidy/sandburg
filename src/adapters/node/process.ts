/**
 * A Node.js process in the browser: Sandburg's runtime (ADR 0006) in a Web
 * Worker, as the host page sees it. Used by the node adapter (the app is the
 * process) and by the esbuild adapter (the app's backend is the process).
 */
import { AdapterError } from '../../host/types.ts';
import type { FileTree } from '../../types.ts';
import type { FromWorker } from '../../node-runtime/worker.ts';
import type { BridgedRequest } from '../sw-bridge.ts';

export interface NodeProcessOptions {
  files: FileTree;
  env: Record<string, string>;
  installKey: string | null;
  /** The URL of a preload bundle for the install (see adapters/node/index.ts). */
  preload?: string | null;
  /** The URL of a bundle of project files to start with. */
  filesBundle?: string | null;
  nodeModules: Record<string, number> | null;
  /** node_modules installed in the browser: one block of shared memory and its index (see npm/install.ts). */
  pack?: { sab: SharedArrayBuffer; index: Record<string, [number, number]> } | null;
  log(stream: 'stdout' | 'stderr', line: string): void;
  /** What the program is, for messages ("the app", "the backend"). */
  label?: string;
  /** Started by a TypeScript runner (tsx, ts-node): `./x.js` imports resolve to `./x.ts`. */
  tsRunner?: boolean;
}

/** A file of a dev server's cache: text, or binary as base64. */
export type CacheFile = string | { base64: string };

/**
 * Where the runtime reaches the host (worker script, installed files, compiles). /__sandburg on a
 * sandbox origin; a page may set another (the static demos serve it under their own path).
 */
export function hostBase(): string {
  return (globalThis as { __sandburgBase?: string }).__sandburgBase ?? '/__sandburg';
}

export class NodeProcess {
  /** Ports the program's HTTP servers listen on, in the order they started. */
  readonly ports: number[] = [];
  /** Commands of the dev script that exited with an error (a backend that crashed, say). */
  readonly failedCommands: { command: string; code: number; stderr: string }[] = [];
  failure: Error | null = null;
  exitCode: number | null = null;
  private worker: Worker;
  private ready = false;
  private waiters = new Set<() => void>();
  private pending = new Map<number, MessagePort>();
  private sockets = new Map<number, MessagePort>();
  private nextId = 1;
  private label: string;
  private partial = { stdout: '', stderr: '' };
  private trees = new Map<number, (files: Record<string, CacheFile>) => void>();
  /** When the page last sent the runtime a request or heard from it (see activity()). */
  private lastActivity = performance.now();

  constructor(opts: NodeProcessOptions) {
    this.label = opts.label ?? 'the app';
    const base = hostBase();
    this.worker = new Worker(`${base}/node-worker.js`);
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data, opts);
    this.worker.onerror = (e) => this.fail(new AdapterError('INTERNAL', `runtime worker error: ${e.message}`));
    this.worker.postMessage({ type: 'init', cwd: '/app', env: opts.env, files: opts.files, installKey: opts.installKey, preload: opts.preload ?? null, filesBundle: opts.filesBundle ?? null, nodeModules: opts.nodeModules, pack: opts.pack ?? null, base, tsRunner: opts.tsRunner });
  }

  /** Resolves when the runtime has loaded. */
  started(): Promise<void> {
    return this.until(() => this.ready);
  }

  run(main: string, argv: string[] = []): void {
    this.worker.postMessage({ type: 'run', main, argv });
  }

  /** Resolves with the first listening port (or `port`, once it listens). Rejects if the program crashes or exits first. */
  async listening(port?: number): Promise<number> {
    await this.until(() => (port === undefined ? this.ports.length > 0 : this.ports.includes(port)));
    return port ?? this.ports[0];
  }

  /**
   * The port whose server serves the app's page: of the ports the program listens on, the first to
   * answer GET / with HTML (a dev script may start an API server before or beside the page's). If
   * none has after `patience` ms without a new port, the first port.
   */
  async pagePort(patience = 20_000): Promise<number> {
    await this.listening();
    const probed = new Set<number>();
    let found: number | null = null;
    let settled = 0;
    let lastPort = Date.now();
    const probe = (port: number) => {
      probed.add(port);
      lastPort = Date.now();
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        const m = e.data as { type: string; status?: number; headers?: [string, string][] };
        if (m.type === 'start' || m.type === 'error') {
          const type = m.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
          if (m.type === 'start' && m.status! < 400 && /html/.test(type) && found === null) found = port;
          settled++;
          channel.port1.close();
          for (const w of this.waiters) w();
        }
      };
      this.request(port, { method: 'GET', url: '/', headers: [['accept', 'text/html']], body: null }, channel.port2);
    };
    const tick = setInterval(() => {
      for (const w of this.waiters) w();
    }, 1000);
    try {
      await this.until(() => {
        for (const port of this.ports) if (!probed.has(port)) probe(port);
        return found !== null || (settled === probed.size && Date.now() - lastPort > patience);
      });
    } finally {
      clearInterval(tick);
    }
    return found ?? this.ports[0];
  }

  /** Forwards a request from the service worker to the server on `port`; the response streams back over `reply`. */
  request(port: number, request: BridgedRequest, reply: MessagePort): void {
    if (this.failure && this.exitCode === null) {
      reply.postMessage({ type: 'error', message: `${this.label} crashed: ${this.failure.message.split('\n')[0]}` });
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, reply);
    this.lastActivity = performance.now();
    // No Accept-Encoding: the browser does not decode compressed bodies of service-worker Responses.
    const headers: [string, string][] = request.headers.filter(([k]) => !/^(cookie|accept-encoding)$/i.test(k));
    if (document.cookie) headers.push(['cookie', document.cookie]);
    // The browser sends Host; a service worker's request does not carry it (dev servers check it: Vite's allowedHosts).
    if (!headers.some(([k]) => k.toLowerCase() === 'host')) headers.push(['host', location.host]);
    this.worker.postMessage({ type: 'request', id, port, method: request.method, url: request.url, headers, body: request.body }, request.body ? [request.body] : []);
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
      ['host', target.host],
      ['origin', location.origin],
      ['user-agent', navigator.userAgent],
    ];
    if (document.cookie) headers.push(['cookie', document.cookie]);
    channel.onmessage = (e) => {
      const m = e.data as { type: 'send'; data: string | ArrayBuffer } | { type: 'close'; code?: number; reason?: string };
      if (m.type === 'send') this.worker.postMessage({ type: 'ws-send', id, data: m.data }, typeof m.data === 'string' ? [] : [m.data]);
      else this.worker.postMessage({ type: 'ws-close', id, code: m.code, reason: m.reason });
    };
    this.worker.postMessage({ type: 'ws-open', id, port, url: target.pathname + target.search, headers, protocols });
  }

  /** Writes a project file in the running program's file system (dev servers' watchers pick it up). */
  writeFile(path: string, content: string): void {
    this.worker.postMessage({ type: 'write-file', path, content });
  }

  /** The text files under project directories, keyed by project-relative path. */
  readTree(dirs: string[]): Promise<Record<string, CacheFile>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.trees.set(id, resolve);
      this.worker.postMessage({ type: 'read-tree', id, dirs });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }

  /**
   * Whether the app's servers are working: requests still being answered, and how long since the
   * runtime last said anything (a response, a log line). Checks stop waiting for an assertion that
   * keeps failing once the runtime is idle: nothing is still coming.
   */
  activity(): { inflight: number; idleMs: number } {
    return { inflight: this.pending.size, idleMs: Math.round(performance.now() - this.lastActivity) };
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
        if (typeof m.port === 'number' && !this.ports.includes(m.port)) this.ports.push(m.port);
        break;
      case 'tree':
        this.trees.get(m.id)?.(m.files);
        this.trees.delete(m.id);
        break;
      case 'process-exit':
        this.failedCommands.push({ command: m.command, code: m.code, stderr: m.stderr });
        break;
      case 'fatal':
        // The runtime could not load one of its own parts: infrastructure, not the app.
        this.fail(new AdapterError(m.message.startsWith('runtime asset failed to load') ? 'INTERNAL' : 'APP', m.stack ?? m.message));
        break;
      case 'exit':
        this.exitCode = m.code;
        if (!this.ports.length) this.fail(new AdapterError('APP', `${this.label} exited with code ${m.code} before it started listening`));
        break;
      case 'response-start': {
        for (const [k, v] of m.headers) if (k.toLowerCase() === 'set-cookie') applyCookie(v);
        this.pending.get(m.id)?.postMessage({ type: 'start', status: m.status, statusText: m.statusText, headers: m.headers });
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
        break;
      case 'response-error':
        this.pending.get(m.id)?.postMessage({ type: 'error', message: m.message });
        this.pending.delete(m.id);
        break;
    }
    for (const w of this.waiters) w();
  }

  /** Ends the wait for the program (listening(), pagePort()) with an error. */
  fail(e: Error) {
    this.failure ??= e;
    for (const w of this.waiters) w();
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
  (window as unknown as Record<string, unknown>).__sandburgWs = (url: string, protocols: string[], channel: MessagePort) => {
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
