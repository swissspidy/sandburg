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

/** Applies a Set-Cookie header to the sandbox origin (a service worker cannot). HttpOnly cannot be honored. */
function applyCookie(header: string) {
  const [pair, ...attrs] = header.split(';');
  const kept = attrs.map((a) => a.trim()).filter((a) => !/^(httponly|secure)$/i.test(a));
  document.cookie = [pair.trim(), ...kept].join('; ');
}
