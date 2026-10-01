/**
 * node:http for the runtime. Servers are virtual: listen() registers the port
 * with the runtime, and the host page delivers requests (from the sandbox's
 * service worker) as IncomingMessage streams; ServerResponse writes stream
 * back chunk by chunk. Client requests go through fetch(), i.e. through the
 * egress gateway like any other browser request.
 */
import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { Duplex, Readable, Writable } from 'readable-stream';

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
export const METHODS = ['ACL', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'MERGE', 'MKCOL', 'MOVE', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PUT', 'PURGE', 'REPORT', 'SEARCH', 'TRACE', 'UNLINK', 'UNLOCK'];

export interface BridgeResponse {
  start(status: number, statusText: string, headers: [string, string][]): void;
  chunk(data: Uint8Array): void;
  end(): void;
}

/** Listening servers by port, or by path for servers on a local socket; the runtime's request dispatcher reads this. */
export const servers = new Map<number | string, Server>();
export const serverEvents = new EventEmitter();

/**
 * Requests to this machine (localhost, or a socketPath) are delivered to virtual servers directly,
 * without the network: this runtime's own (`servers`), and through `loopback.route` those of other
 * runtimes (threads, child processes: see worker.ts). Anything else goes through fetch().
 */
export const loopback: {
  route?(target: number | string, method: string, url: string, headers: [string, string][], body: Uint8Array | null, bridge: BridgeResponse & { error(message: string, code?: string): void }): boolean;
} = {};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '']);

class FakeSocket extends EventEmitter {
  /** The server that accepted the connection (Next.js finds its HTTP server through req.socket.server). */
  server: Server | null = null;
  remoteAddress = '127.0.0.1';
  remotePort = 50000;
  localAddress = '127.0.0.1';
  localPort: number;
  encrypted = false;
  readable = true;
  writable = true;
  destroyed = false;
  constructor(port: number) {
    super();
    this.localPort = port;
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.localPort }; }
  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
  end() { return this.destroy(); }
  write() { return true; }
  cork() {}
  uncork() {}
}

/** Where the bytes a server writes to an upgraded socket go (the runtime's WebSocket client codec). */
export interface UpgradeSink {
  data(bytes: Uint8Array): void;
  end(): void;
}

/**
 * The socket of an upgraded connection ('upgrade' event): a Duplex whose writes go to the
 * client side in the runtime and whose reads are what the client sends. `ws` (and so socket.io,
 * Next.js' HMR server) speaks the WebSocket protocol over it.
 */
export class UpgradeSocket extends Duplex {
  server: Server | null = null;
  remoteAddress = '127.0.0.1';
  remotePort = 50001;
  remoteFamily = 'IPv4';
  localAddress = '127.0.0.1';
  localPort: number;
  encrypted = false;
  connecting = false;
  bytesWritten = 0;
  private sink: UpgradeSink;
  private ended = false;

  constructor(port: number, sink: UpgradeSink) {
    super({ allowHalfOpen: false });
    this.localPort = port;
    this.sink = sink;
  }
  _read() {}
  _write(chunk: unknown, encoding: BufferEncoding, cb: (e?: Error | null) => void) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : (chunk as Uint8Array);
    this.bytesWritten += bytes.length;
    this.sink.data(new Uint8Array(bytes));
    cb();
  }
  _final(cb: (e?: Error | null) => void) {
    this.finish();
    cb();
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.finish();
    cb(err);
  }
  /** Bytes from the client. */
  receive(bytes: Uint8Array) {
    if (!this.destroyed) this.push(Buffer.from(bytes));
  }
  /** The client went away. */
  hangUp() {
    if (!this.destroyed) {
      this.push(null);
      this.destroy();
    }
  }
  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.sink.end();
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.localPort }; }
  get readyState() { return this.destroyed ? 'closed' : 'open'; }
}

export class IncomingMessage extends Readable {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  rawHeaders: string[];
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  socket: FakeSocket | UpgradeSocket;
  connection: FakeSocket | UpgradeSocket;
  complete = false;
  aborted = false;
  statusCode?: number;
  statusMessage?: string;
  constructor(method: string, url: string, headers: [string, string][], port: number) {
    super();
    this.method = method;
    this.url = url;
    this.rawHeaders = headers.flat();
    this.headers = {};
    for (const [k, v] of headers) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') ((this.headers[key] ??= []) as string[]).push(v);
      else this.headers[key] = key in this.headers ? `${this.headers[key]}, ${v}` : v;
    }
    this.socket = this.connection = new FakeSocket(port);
  }
  _read() {}
  setTimeout() { return this; }
}

export class ServerResponse extends Writable {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  sendDate = true;
  finished = false;
  req: IncomingMessage;
  socket: FakeSocket;
  connection: FakeSocket;
  chunkedEncoding = false;
  shouldKeepAlive = false;
  strictContentLength = false;
  private headerMap = new Map<string, { name: string; value: string | string[] }>();
  private bridge: BridgeResponse;
  constructor(req: IncomingMessage, bridge: BridgeResponse) {
    super({ decodeStrings: false });
    this.req = req;
    this.bridge = bridge;
    this.socket = this.connection = req.socket as FakeSocket;
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    this.headerMap.set(name.toLowerCase(), { name, value: Array.isArray(value) ? [...value].map(String) : String(value) });
    return this;
  }
  setHeaders(headers: Headers | Map<string, string>) {
    headers.forEach((v, k) => this.setHeader(k, v));
    return this;
  }
  appendHeader(name: string, value: string | string[]) {
    const prev = this.headerMap.get(name.toLowerCase())?.value;
    const next = ([] as string[]).concat(prev ?? [], value);
    return this.setHeader(name, next);
  }
  getHeader(name: string) { return this.headerMap.get(name.toLowerCase())?.value; }
  getHeaders() {
    const o: Record<string, string | string[]> = Object.create(null);
    for (const [k, { value }] of this.headerMap) o[k] = value;
    return o;
  }
  getHeaderNames() { return [...this.headerMap.keys()]; }
  getRawHeaderNames() { return [...this.headerMap.values()].map((h) => h.name); }
  hasHeader(name: string) { return this.headerMap.has(name.toLowerCase()); }
  removeHeader(name: string) { this.headerMap.delete(name.toLowerCase()); }
  flushHeaders() { this.sendHeaders(); }
  /** Node internal that middleware (e.g. compression) calls to commit the status line and headers. */
  _implicitHeader() { this.writeHead(this.statusCode); }
  writeHead(status: number, msgOrHeaders?: string | Record<string, unknown> | unknown[], maybeHeaders?: Record<string, unknown> | unknown[]) {
    this.statusCode = status;
    let headers = maybeHeaders;
    if (typeof msgOrHeaders === 'string') this.statusMessage = msgOrHeaders;
    else headers = msgOrHeaders;
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.appendHeader(String(headers[i]), String(headers[i + 1]));
    } else if (headers) {
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) this.setHeader(k, v as string);
    }
    return this;
  }
  writeContinue() {}
  writeEarlyHints() {}
  addTrailers() {}
  assignSocket() {}
  detachSocket() {}
  setTimeout() { return this; }
  private sendHeaders() {
    if (this.headersSent) return;
    this.headersSent = true;
    const list: [string, string][] = [];
    for (const { name, value } of this.headerMap.values()) {
      for (const v of Array.isArray(value) ? value : [value]) list.push([name, v]);
    }
    this.bridge.start(this.statusCode, this.statusMessage || STATUS_CODES[this.statusCode] || '', list);
  }
  _write(chunk: unknown, encoding: BufferEncoding, cb: (e?: Error | null) => void) {
    this.sendHeaders();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : (chunk as Uint8Array);
    if (bytes.length && this.req.method !== 'HEAD') this.bridge.chunk(new Uint8Array(bytes));
    cb();
  }
  _final(cb: (e?: Error | null) => void) {
    this.sendHeaders();
    this.finished = true;
    this.bridge.end();
    cb();
    queueMicrotask(() => this.emit('close'));
  }
  // Node's res.end(data, encoding, cb) also accepts (cb) and (data, cb).
  end(...args: unknown[]) {
    return super.end(...(args as []));
  }
}

export class Server extends EventEmitter {
  listening = false;
  private port: number | string = 0;
  timeout = 0;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  maxHeadersCount: number | null = null;
  constructor(opts?: unknown, handler?: (req: IncomingMessage, res: ServerResponse) => void) {
    super();
    const h = typeof opts === 'function' ? opts : handler;
    if (h) this.on('request', h as never);
  }
  listen(...args: unknown[]) {
    const cb = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : undefined;
    const first = args[0];
    // A local socket (a path, or an abstract \0name) or a TCP port.
    const path = typeof first === 'string' && !/^\d+$/.test(first) ? first : typeof first === 'object' && first && typeof (first as { path?: unknown }).path === 'string' ? (first as { path: string }).path : null;
    if (path !== null) this.port = path;
    else {
      const port = typeof first === 'object' && first ? Number((first as { port?: number }).port ?? 0) : Number(first ?? 0);
      let p = port || 3000;
      while (servers.has(p) && servers.get(p) !== this) p++;
      this.port = p;
    }
    servers.set(this.port, this);
    this.listening = true;
    queueMicrotask(() => {
      // The runtime learns of the server first, so it is reachable when the program is told.
      serverEvents.emit('listening', this.port);
      this.emit('listening');
      cb?.();
    });
    return this;
  }
  address() {
    if (!this.listening) return null;
    return typeof this.port === 'string' ? this.port : { address: '127.0.0.1', family: 'IPv4', port: this.port };
  }
  close(cb?: (e?: Error) => void) {
    if (servers.get(this.port) === this) servers.delete(this.port);
    this.listening = false;
    queueMicrotask(() => {
      this.emit('close');
      cb?.();
    });
    return this;
  }
  closeAllConnections() {}
  closeIdleConnections() {}
  setTimeout() { return this; }
  ref() { return this; }
  unref() { return this; }
  getConnections(cb: (e: null, n: number) => void) { cb(null, 0); }

  /** Called by the runtime for each bridged request. */
  dispatch(method: string, url: string, headers: [string, string][], body: Uint8Array | null, bridge: BridgeResponse) {
    // Requests surfaced in a service worker carry no Content-Length; a real connection would.
    // Body parsers (e.g. Express') use it to decide whether a request has a body.
    if (body && !headers.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k))) headers = [...headers, ['content-length', String(body.length)]];
    const req = new IncomingMessage(method, url, headers, typeof this.port === 'number' ? this.port : 0);
    (req.socket as FakeSocket).server = this;
    const res = new ServerResponse(req, bridge);
    if (body?.length) req.push(Buffer.from(body));
    req.push(null);
    req.complete = true;
    this.emit('request', req, res);
  }

  /**
   * An upgrade request (WebSocket): emits 'upgrade' with a socket whose writes go to `sink`.
   * Returns null when nothing handles upgrades, as Node then closes the connection.
   */
  upgrade(url: string, headers: [string, string][], sink: UpgradeSink): UpgradeSocket | null {
    if (!this.listenerCount('upgrade')) return null;
    const socket = new UpgradeSocket(typeof this.port === 'number' ? this.port : 0, sink);
    socket.server = this;
    const req = new IncomingMessage('GET', url, headers, typeof this.port === 'number' ? this.port : 0);
    req.socket = req.connection = socket;
    req.push(null);
    req.complete = true;
    this.emit('upgrade', req, socket, Buffer.alloc(0));
    return socket;
  }
}

export function createServer(opts?: unknown, handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  return new Server(opts, handler);
}

// --- client -------------------------------------------------------------------------

export class Agent extends EventEmitter {
  options: Record<string, unknown>;
  maxSockets = Infinity;
  sockets = {};
  requests = {};
  freeSockets = {};
  constructor(opts: Record<string, unknown> = {}) {
    super();
    this.options = opts;
  }
  destroy() {}
}
export const globalAgent = new Agent();

class ClientRequest extends Writable {
  private chunks: Uint8Array[] = [];
  private headers: Record<string, string> = {};
  method: string;
  path: string;
  host: string;
  private url: string;
  /** A server on this machine: a port on localhost, or a socket path. */
  private target: number | string | null;
  socket: FakeSocket;
  connection: FakeSocket;
  private controller = new AbortController();
  aborted = false;
  constructor(url: string, method: string, headers: Record<string, string>, cb?: (res: IncomingMessage) => void, socketPath?: string) {
    super();
    const u = new URL(url);
    this.url = url;
    this.target = socketPath ?? (LOCAL_HOSTS.has(u.hostname) ? Number(u.port || (u.protocol === 'https:' ? 443 : 80)) : null);
    // As in Node, the request gets its (connected) socket on a later tick; proxies (httpxy) wait for it.
    this.socket = this.connection = Object.assign(new FakeSocket(0), { pending: false, connecting: false });
    queueMicrotask(() => this.emit('socket', this.socket));
    this.method = method;
    this.path = u.pathname + u.search;
    this.host = u.host;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    if (cb) this.once('response', cb);
  }
  headersSent = false;
  setHeader(k: string, v: string | number | string[]) {
    this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return this;
  }
  appendHeader(k: string, v: string | string[]) {
    const key = k.toLowerCase();
    const add = Array.isArray(v) ? v.join(', ') : String(v);
    this.headers[key] = key in this.headers ? `${this.headers[key]}, ${add}` : add;
    return this;
  }
  getHeader(k: string) { return this.headers[k.toLowerCase()]; }
  hasHeader(k: string) { return k.toLowerCase() in this.headers; }
  getHeaders() { return { ...this.headers }; }
  getHeaderNames() { return Object.keys(this.headers); }
  getRawHeaderNames() { return Object.keys(this.headers); }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  setTimeout() { return this; }
  setNoDelay() {}
  setSocketKeepAlive() {}
  flushHeaders() {}
  abort() {
    this.aborted = true;
    this.controller.abort();
  }
  destroy(err?: Error) {
    this.controller.abort();
    return super.destroy(err);
  }
  _write(chunk: unknown, enc: BufferEncoding, cb: () => void) {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : (chunk as Uint8Array));
    cb();
  }
  /** Delivers the request to a server on this machine, if there is one. */
  private local(body: Uint8Array | null): boolean {
    let res: IncomingMessage | null = null;
    const bridge = {
      start: (status: number, statusText: string, headers: [string, string][]) => {
        res = new IncomingMessage(this.method, this.path, headers, 0);
        res.statusCode = status;
        res.statusMessage = statusText;
        this.emit('response', res);
      },
      chunk: (data: Uint8Array) => res?.push(Buffer.from(data)),
      end: () => {
        if (res) {
          res.complete = true;
          res.push(null);
        }
      },
      error: (message: string, code = 'ECONNRESET') => this.emit('error', Object.assign(new Error(message), { code })),
    };
    const headers: [string, string][] = Object.entries(this.headers);
    if (!('host' in this.headers)) headers.push(['host', this.host || 'localhost']);
    const server = servers.get(this.target!);
    if (server) {
      queueMicrotask(() => server.dispatch(this.method, this.path, headers, body, bridge));
      return true;
    }
    return loopback.route?.(this.target!, this.method, this.path, headers, body, bridge) ?? false;
  }
  _final(cb: () => void) {
    const body = this.chunks.length ? Buffer.concat(this.chunks) : undefined;
    if (this.target !== null && this.local(body ?? null)) return cb();
    fetch(this.url, { method: this.method, headers: this.headers, body: this.method === 'GET' || this.method === 'HEAD' ? undefined : body, signal: this.controller.signal, redirect: 'manual' })
      .then(async (r) => {
        const headers: [string, string][] = [];
        r.headers.forEach((v, k) => headers.push([k, v]));
        const msg = new IncomingMessage(this.method, this.path, headers, 0);
        msg.statusCode = r.status;
        msg.statusMessage = r.statusText;
        this.emit('response', msg);
        const reader = r.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            msg.push(Buffer.from(value));
          }
        }
        msg.push(null);
      })
      .catch((e) => this.emit('error', Object.assign(new Error((e as Error)?.message ?? String(e), { cause: e }), { code: 'ECONNREFUSED' })));
    cb();
  }
}

export function makeClient(defaultProtocol: 'http:' | 'https:') {
  function request(input: string | URL | Record<string, unknown>, opts?: unknown, cb?: (res: IncomingMessage) => void) {
    let o: Record<string, unknown> = {};
    let url: string;
    if (typeof input === 'string' || input instanceof URL) {
      url = String(input);
      if (typeof opts === 'function') cb = opts as typeof cb;
      else if (opts) o = opts as Record<string, unknown>;
    } else {
      o = input;
      if (typeof opts === 'function') cb = opts as typeof cb;
      const protocol = (o.protocol as string) ?? defaultProtocol;
      const host = (o.hostname as string) ?? (o.host as string) ?? 'localhost';
      url = `${protocol}//${host}${o.port ? `:${o.port}` : ''}${(o.path as string) ?? '/'}`;
    }
    return new ClientRequest(url, ((o.method as string) ?? 'GET').toUpperCase(), (o.headers as Record<string, string>) ?? {}, cb, typeof o.socketPath === 'string' ? o.socketPath : undefined);
  }
  function get(input: string | URL | Record<string, unknown>, opts?: unknown, cb?: (res: IncomingMessage) => void) {
    const req = request(input, opts, cb);
    req.end();
    return req;
  }
  return { request, get };
}

export const http = {
  ...makeClient('http:'),
  createServer,
  Server,
  IncomingMessage,
  ServerResponse,
  OutgoingMessage: Writable,
  ClientRequest,
  Agent,
  globalAgent,
  STATUS_CODES,
  METHODS,
  maxHeaderSize: 16384,
  validateHeaderName: (name: string) => {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: 'ERR_INVALID_HTTP_TOKEN' });
  },
  validateHeaderValue: (_name: string, value: unknown) => {
    if (value === undefined) throw Object.assign(new TypeError('Invalid value "undefined" for header'), { code: 'ERR_HTTP_INVALID_HEADER_VALUE' });
  },
  setMaxIdleHTTPParsers: () => {},
};

export const https = { ...http, ...makeClient('https:'), Agent, globalAgent: new Agent() };
