/**
 * Serves sandbox host pages. One HTTP server answers for every sandbox; each
 * sandbox is its own origin, http://<id>.sandburg.localhost:<port>, so service
 * workers, storage and cookies never mix between parallel tabs (ADR 0001).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import * as esbuild from 'esbuild';
import type { AdapterDescriptor } from '../types.ts';
import { source } from '../sources.ts';
import { PAGE_CHECKS_PATH, runtimeBundle } from '../page-checks/index.ts';
import { CLASSIC_CHARSET, classicBody, type HostScript } from './code-cache.ts';
import { acceptFileChannel, FILE_CHANNEL_PATH } from './host-socket.ts';
import { traceTransfer, tracingTransfers } from '../transfer-trace.ts';

const HOST_ENTRY = source('host/host.ts');
export const SANDBOX_DOMAIN = 'sandburg.localhost';

const HOST_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>sandburg</title>
<style>html,body{margin:0;height:100%}#app{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<iframe id="app" title="app"></iframe>${tracingTransfers ? '<script>window.__sandburgTraceTransfers = true</script>' : ''}
<script type="module" src="/__sandburg/host.js"></script>
</body>
</html>
`;

/**
 * axe-core, which the accessibility check loads into the app's frame from its own origin (see
 * runAxe in checks.ts): a module script, which the browser compiles off the main thread.
 */
export const AXE_PATH = '/__sandburg/axe.js';
/** axe-core as a classic script in a charset Chromium does not stream, which a run loads with its compiled code (code-cache.ts). */
export const AXE_CLASSIC_PATH = '/__sandburg/axe.classic.js';
let axe: Promise<Buffer> | null = null;
const axeSource = () => (axe ??= readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js')));
let axeClassic: Promise<Buffer> | null = null;
/** axe-core, for the code cache. */
export const AXE_SCRIPT: HostScript = { name: 'axe', source: async () => (await axeSource()).toString('utf8') };

const bundles = new Map<string, Promise<string>>();

/** Bundles the host page with the adapter's browser module. Cached per adapter. */
export function bundleHost(adapter: AdapterDescriptor): Promise<string> {
  let bundle = bundles.get(adapter.name);
  if (!bundle) {
    const aliases: Record<string, string> = { 'sandburg:adapter': adapter.browserEntry, ...adapter.bundleAliases };
    bundle = esbuild
      .build({
        entryPoints: [HOST_ENTRY],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent',
        define: adapter.bundleDefines,
        plugins: [
          {
            name: 'sandburg-aliases',
            setup(build) {
              const filter = new RegExp(`^(${Object.keys(aliases).map(escapeRegExp).join('|')})$`);
              build.onResolve({ filter }, (args) => ({ path: aliases[args.path] }));
            },
          },
        ],
      })
      .then((result) => result.outputFiles[0].text);
    bundle.catch(() => bundles.delete(adapter.name));
    bundles.set(adapter.name, bundle);
  }
  return bundle;
}

/** The largest request body a route reads unless it allows more (HostRequest.body). */
export const BODY_MAX = 1 << 20;

/** How long a refused body's connection is kept, discarding what comes, before it is closed. */
const BODY_REFUSED_GRACE_MS = 1000;

/** A request body over its route's limit: answered with a 413, and the connection closed. */
class BodyTooLargeError extends Error {
  constructor(max: number) {
    super(`request body over ${max} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads a request's body, refusing it as soon as its Content-Length or the bytes received exceed `max`.
 * What comes after a refusal is dropped as it arrives (the stream is not destroyed: that would close
 * the connection before the 413 is sent).
 */
/** The bytes of each request's body that readBody received, for tracing (traceResponse). */
const bodyBytes = new WeakMap<IncomingMessage, number>();

function readBody(req: IncomingMessage, max = BODY_MAX): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && !(Number(declared) <= max)) return Promise.reject(new BodyTooLargeError(max));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const done = () => {
      bodyBytes.set(req, length);
      req.off('data', onData).off('end', onEnd).off('error', onError);
      req.on('data', () => {}).on('error', () => {});
    };
    const onData = (c: Buffer) => {
      length += c.length;
      if (length > max) {
        done();
        chunks.length = 0;
        return reject(new BodyTooLargeError(max));
      }
      chunks.push(c);
    };
    const onEnd = () => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      done();
      reject(err);
    };
    req.on('data', onData).on('end', onEnd).on('error', onError);
  });
}

/** The path of arguments stashed for a sandbox's host page (see HostServer.stash). */
const ARGS_PATH = '/__sandburg/args/';
/** How long stashed arguments wait for their page. */
const STASH_TTL_MS = 120_000;

export class HostServer {
  private server: Server;
  private sandboxes = new Map<string, AdapterDescriptor>();
  /** Arguments of calls into host pages, by id: for one sandbox, served once (see stash). */
  private stashed = new Map<string, { sandbox: string; body: string }>();
  port = 0;

  /**
   * `onError` gets what failed while answering a request (logged on the host's stderr by default);
   * the page gets a 500 without it: an error's message and stack name the host's paths.
   */
  constructor({ onError = (err: unknown, path: string) => console.error(`sandburg: the host server failed to answer ${path}:`, err) } = {}) {
    this.server = createServer((req, res) => {
      if (tracingTransfers) traceResponse(req, res);
      this.handle(req, res).catch((err) => {
        try {
          onError(err, (req.url ?? '').split('?')[0].slice(0, 300));
        } catch {
          // a failing logger does not end the process either
        }
        // After the headers went out, the connection is all that is left to end.
        if (res.headersSent) return void res.destroy();
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error (logged by the host)');
      });
    });
    // The runtime's file requests over a WebSocket (host-socket.ts).
    // One connection's handling never takes the process down: a fault closes that connection only.
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      try {
        const id = this.sandboxOf(req);
        const adapter = id ? this.sandboxes.get(id) : undefined;
        if (!id || !adapter?.serve || URL.parse(req.url ?? '/', 'http://x')?.pathname !== FILE_CHANNEL_PATH) {
          socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        acceptFileChannel(req, socket, this.origin(id), (r) => adapter.serve!({ ...r, sandbox: id }));
      } catch {
        socket.destroy();
      }
    });
  }

  /** The sandbox a request is for, by its Host. */
  private sandboxOf(req: IncomingMessage): string | null {
    const host = (req.headers.host ?? '').toLowerCase();
    return host.endsWith(`.${SANDBOX_DOMAIN}:${this.port}`) ? host.split('.')[0] : null;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Registers a sandbox and returns its origin. `id` must be a DNS label. */
  register(id: string, adapter: AdapterDescriptor): string {
    if (!/^[a-z0-9-]{1,63}$/.test(id)) throw new Error(`invalid sandbox id: ${id}`);
    this.sandboxes.set(id, adapter);
    return this.origin(id);
  }

  unregister(id: string): void {
    this.sandboxes.delete(id);
    for (const [key, stash] of this.stashed) if (stash.sandbox === id) this.stashed.delete(key);
  }

  /**
   * Keeps a call's arguments (JSON) for sandbox `id`'s host page, which fetches them from the path
   * returned, once, instead of receiving them through page.evaluate: Playwright validates and
   * serializes an argument value by value on the host's thread (a run's install data, with the
   * installed files' index of 10-12k entries, was ~1.8 s of it in a 24-app batch). The path's id
   * is random, and only that sandbox's origin is served it.
   */
  stash(id: string, body: string): string {
    const key = randomBytes(18).toString('base64url');
    this.stashed.set(key, { sandbox: id, body });
    setTimeout(() => this.stashed.delete(key), STASH_TTL_MS).unref();
    return ARGS_PATH + key;
  }

  origin(id: string): string {
    return `http://${id}.${SANDBOX_DOMAIN}:${this.port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = this.sandboxOf(req);
    const adapter = id ? this.sandboxes.get(id) : undefined;
    if (!adapter) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('unknown sandbox');
      return;
    }
    // Requests from another site (another sandbox: they are all *.sandburg.localhost) are refused: the
    // egress gateway does not see a sandbox's plain-HTTP requests (see EgressGateway.attach).
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-site' || site === 'cross-site') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('requests from another site are refused');
      return;
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (adapter.crossOriginIsolation) {
      headers['cross-origin-opener-policy'] = 'same-origin';
      headers['cross-origin-embedder-policy'] = adapter.crossOriginIsolation === 'credentialless' ? 'credentialless' : 'require-corp';
    }
    const url = URL.parse(req.url ?? '/', 'http://x');
    if (!url) {
      res.writeHead(400, { ...headers, 'content-type': 'text/plain' });
      res.end('bad request target');
      return;
    }
    const path = url.pathname;
    if (path.startsWith(ARGS_PATH)) {
      // Another sandbox's arguments are not found here, nor are ones already taken.
      const key = path.slice(ARGS_PATH.length);
      const stash = this.stashed.get(key);
      if (!stash || stash.sandbox !== id || req.method !== 'GET') {
        res.writeHead(404, { ...headers, 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      this.stashed.delete(key);
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(stash.body);
    } else if (path === '/' || path === '/index.html' || path === '/__sandburg/') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(HOST_HTML);
    } else if (path === '/__sandburg/host.js') {
      const js = await bundleHost(adapter);
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
    } else if (path === PAGE_CHECKS_PATH) {
      const js = await runtimeBundle();
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
    } else if (path === AXE_PATH) {
      const js = await axeSource();
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
    } else if (path === AXE_CLASSIC_PATH) {
      const js = await (axeClassic ??= AXE_SCRIPT.source().then(classicBody));
      res.writeHead(200, { ...headers, 'content-type': `text/javascript; charset=${CLASSIC_CHARSET}` });
      res.end(js);
    } else if (path.startsWith('/__sandburg/') && adapter.serve) {
      let out;
      try {
        out = await adapter.serve({
          method: req.method ?? 'GET',
          path,
          query: url.searchParams,
          sandbox: id!,
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])),
          body: (max) => readBody(req, max),
        });
      } catch (err) {
        if (!(err instanceof BodyTooLargeError)) throw err;
        // The rest of the body is discarded as it comes (never kept), for a moment: closing at once,
        // with the client's bytes unread, resets the connection and can lose the answer. Then the
        // connection closes, unless the body ended by then.
        res.writeHead(413, { ...headers, 'content-type': 'text/plain' });
        res.end('request body too large');
        res.once('finish', () => setTimeout(() => !req.complete && req.socket.destroy(), BODY_REFUSED_GRACE_MS).unref());
        return;
      }
      if (!out) {
        res.writeHead(404, { ...headers, 'content-type': 'text/plain' });
        res.end('not found');
      } else {
        res.writeHead(out.status, { ...headers, ...out.headers });
        res.end(out.body);
      }
    } else if (adapter.assets[path]) {
      const body = await readFile(adapter.assets[path]);
      res.writeHead(200, { ...headers, 'content-type': contentType(path) });
      res.end(body);
    } else {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain' });
      res.end('not found');
    }
  }
}

/** Traces a response's body and a request's (SANDBURG_TRACE_TRANSFERS). */
function traceResponse(req: IncomingMessage, res: ServerResponse): void {
  const t0 = performance.now();
  let sent = 0;
  const end = res.end.bind(res) as (body?: unknown) => ServerResponse;
  (res as { end: (body?: unknown) => ServerResponse }).end = (body?: unknown) => {
    if (typeof body === 'string') sent = Buffer.byteLength(body);
    else if (body instanceof Uint8Array) sent = body.length;
    return end(body);
  };
  res.once('finish', () => {
    const path = (req.url ?? '').split('?')[0];
    const ms = performance.now() - t0;
    // Counted as readBody read it: a listener of its own here would start the body flowing before the adapter reads it.
    const received = bodyBytes.get(req) ?? 0;
    const binary = /octet-stream|wasm/.test(String(res.getHeader('content-type') ?? ''));
    traceTransfer({ hop: 'host→page http', what: `${req.method} ${path}`, bytes: sent, encoding: binary ? 'binary' : 'text', ms });
    traceTransfer({ hop: 'page→host http', what: `${req.method} ${path}`, bytes: received, encoding: String(req.headers['content-type'] ?? '').includes('json') ? 'json' : 'binary', ms });
  });
}

function contentType(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
