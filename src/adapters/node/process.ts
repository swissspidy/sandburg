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
  nodeModules: Record<string, number> | null;
  log(stream: 'stdout' | 'stderr', line: string): void;
  /** What the program is, for messages ("the app", "the backend"). */
  label?: string;
  /** Started by a TypeScript runner (tsx, ts-node): `./x.js` imports resolve to `./x.ts`. */
  tsRunner?: boolean;
}

export class NodeProcess {
  /** Ports the program's HTTP servers listen on, in the order they started. */
  readonly ports: number[] = [];
  failure: Error | null = null;
  exitCode: number | null = null;
  private worker: Worker;
  private ready = false;
  private waiters = new Set<() => void>();
  private pending = new Map<number, MessagePort>();
  private sockets = new Map<number, MessagePort>();
  private nextId = 1;
  private label: string;

  constructor(opts: NodeProcessOptions) {
    this.label = opts.label ?? 'the app';
    this.worker = new Worker('/__sandburg/node-worker.js');
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data, opts);
    this.worker.onerror = (e) => this.fail(new AdapterError('INTERNAL', `runtime worker error: ${e.message}`));
    this.worker.postMessage({ type: 'init', cwd: '/app', env: opts.env, files: opts.files, installKey: opts.installKey, nodeModules: opts.nodeModules, base: '/__sandburg', tsRunner: opts.tsRunner });
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

  /** Forwards a request from the service worker to the server on `port`; the response streams back over `reply`. */
  request(port: number, request: BridgedRequest, reply: MessagePort): void {
    if (this.failure && this.exitCode === null) {
      reply.postMessage({ type: 'error', message: `${this.label} crashed: ${this.failure.message.split('\n')[0]}` });
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, reply);
    // No Accept-Encoding: the browser does not decode compressed bodies of service-worker Responses.
    const headers: [string, string][] = request.headers.filter(([k]) => !/^(cookie|accept-encoding)$/i.test(k));
    if (document.cookie) headers.push(['cookie', document.cookie]);
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

  terminate(): void {
    this.worker.terminate();
  }

  private onMessage(m: FromWorker, opts: NodeProcessOptions) {
    switch (m.type) {
      case 'log':
        for (const line of m.text.replace(/\n$/, '').split('\n')) opts.log(m.stream, line);
        break;
      case 'ready':
        this.ready = true;
        break;
      case 'listening':
        if (!this.ports.includes(m.port)) this.ports.push(m.port);
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

  private fail(e: Error) {
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
