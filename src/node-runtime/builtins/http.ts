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
import { ExitError, timers } from './process.ts';

const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
const METHODS = ['ACL', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'MERGE', 'MKCOL', 'MOVE', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PUT', 'PURGE', 'REPORT', 'SEARCH', 'TRACE', 'UNLINK', 'UNLOCK'];

export interface BridgeResponse {
  start(status: number, statusText: string, headers: [string, string][]): void;
  chunk(data: Uint8Array): void;
  end(): void;
  /** The connection was reset before the response ended (res.destroy(), its socket closed): Node's client sees ECONNRESET. */
  error?(message: string, code?: string): void;
  /** The status line and headers were flushed (res.flushHeaders()): what was sent so far goes out now, whatever comes after. */
  flush?(): void;
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
  /** Routes a request to another runtime's server: false if there is none, else what tells the server its client went away. */
  route?(target: number | string, method: string, url: string, headers: [string, string][], body: Uint8Array | null, bridge: BridgeResponse & { error(message: string, code?: string): void }): false | (() => void);
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
    if (this.destroyed) return this;
    this.destroyed = true;
    // As a real socket's, later.
    queueMicrotask(() => this.emit('close'));
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
  destroy(err?: Error) {
    // As Node: destroyed before it was read to its end, it was aborted, and its connection closes. Here,
    // not in _destroy, whose throws the stream catches: process.exit() in an 'aborted' listener ends the process.
    if (!this.destroyed && !this.aborted && (!this.readableEnded || !this.complete)) {
      this.aborted = true;
      try {
        this.emit('aborted');
      } catch (e) {
        // As Node: what a listener throws is the request's error (process.exit() ends the process).
        if (e instanceof ExitError) throw e;
        err = e as Error;
      }
      super.destroy(err);
      if (!this.socket.destroyed) this.socket.destroy();
      return this;
    }
    return super.destroy(err);
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    // As Node: an error is emitted only to listeners ('aborted' and 'close' tell the others).
    cb(this.listenerCount('error') ? err : null);
  }
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
    // Its 'close' is emitted once (emitCloseOnce): as Node's, at once when its connection closes.
    super({ decodeStrings: false, emitClose: false });
    this.req = req;
    this.bridge = bridge;
    this.socket = this.connection = req.socket as FakeSocket;
  }
  private hasClosed = false;
  /**
   * What it sent in this tick, held until its end (as a socket's writes go out after it): destroyed in
   * the same tick, none of it goes out, and its client sees only the reset (as in Node).
   */
  #held: (() => void)[] | null = null;
  #send(out: () => void) {
    if (!this.#held) {
      this.#held = [];
      queueMicrotask(() => this.#flushHeld());
    }
    this.#held.push(out);
  }
  #flushHeld() {
    const held = this.#held;
    this.#held = null;
    if (held) for (const out of held) out();
  }
  /** A 'clientError' to come ('pending'), and with its 'close' held until it came ('close'). */
  private clientError: 'pending' | 'close' | null = null;
  /**
   * Its connection closed before it ended (see Server.dispatch): it closes at once, and the client's
   * request fails ("socket hang up"), after the server's side has seen it close.
   */
  connectionClosed() {
    this.destroy();
    this.emitCloseOnce();
    queueMicrotask(() => this.bridge.error?.('socket hang up', 'ECONNRESET'));
  }
  private emitCloseOnce() {
    if (this.hasClosed) return;
    if (this.clientError) return void (this.clientError = 'close');
    this.hasClosed = true;
    this.emit('close');
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
  /** As Node's: the status line and headers go out at once (only writes wait for the end of the tick). */
  flushHeaders() {
    this.sendHeaders();
    this.#flushHeld();
    this.bridge.flush?.();
  }
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
    const status = this.statusCode;
    const text = this.statusMessage || STATUS_CODES[status] || '';
    this.#send(() => this.bridge.start(status, text, list));
  }
  _write(chunk: unknown, encoding: BufferEncoding, cb: (e?: Error | null) => void) {
    this.sendHeaders();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : (chunk as Uint8Array);
    if (bytes.length && this.req.method !== 'HEAD') {
      const data = new Uint8Array(bytes);
      this.#send(() => this.bridge.chunk(data));
    }
    cb();
  }
  _final(cb: (e?: Error | null) => void) {
    this.sendHeaders();
    this.finished = true;
    this.#flushHeld();
    this.bridge.end();
    cb();
    queueMicrotask(() => this.emitCloseOnce());
  }
  destroy(err?: Error) {
    // As Node: the error is the socket's, for the server's 'clientError' (also once the response ended),
    // later, outside the stream's catch and the caller's; never emitted on the response.
    // Its 'close' waits for it, as Node's comes after its socket's error.
    const server = this.socket.server;
    if (err && !this.destroyed && server?.listenerCount('clientError')) {
      this.clientError = 'pending';
      queueMicrotask(() => {
        const held = this.clientError === 'close';
        this.clientError = null;
        try {
          server.emit('clientError', err, this.socket);
        } catch (e) {
          if (!(e instanceof ExitError) && held) this.emitCloseOnce();
          throw e;
        }
        if (held) this.emitCloseOnce();
      });
    }
    return super.destroy();
  }
  _destroy(_err: Error | null, cb: (e?: Error | null) => void) {
    // Destroyed before it ended: its connection closes, which aborts the request (see Server.dispatch);
    // what it sent in this tick does not go out.
    if (!this.finished) {
      this.#held = null;
      this.socket.destroy();
    }
    cb(null);
  }
  // Node's res.end(data, encoding, cb) also accepts (cb) and (data, cb).
  end(...args: unknown[]) {
    return super.end(...(args as []));
  }
}

export class Server extends EventEmitter {
  listening = false;
  private port: number | string = 0;
  /** Listening on a port the system picked (port 0): a tool's probe or internal server, not the app's. */
  ephemeral = false;
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
      const options = typeof first === 'object' && first ? (first as { port?: number; reusePort?: boolean }) : null;
      const port = options ? Number(options.port ?? 0) : Number(first ?? 0);
      // As where the platform has no SO_REUSEPORT, and as for any port another server holds: tools
      // probe for both (@nuxt/cli 4 hands a port from one process to the next only with reusePort).
      const refuse = (code: string, message: string) => {
        queueMicrotask(() => this.emit('error', Object.assign(new Error(`listen ${code}: ${message}`), { code, errno: code, syscall: 'listen', port })));
        return this;
      };
      if (options?.reusePort) return refuse('ENOTSUP', 'reusePort is not supported');
      if (port && servers.has(port) && servers.get(port) !== this) return refuse('EADDRINUSE', `address already in use :::${port}`);
      // Port 0: a free port the system picks (net.ts picks from the same range).
      let p = port;
      if (!p) do p = 40000 + Math.floor(Math.random() * 20000); while (servers.has(p));
      this.port = p;
      this.ephemeral = !port;
    }
    servers.set(this.port, this);
    this.listening = true;
    queueMicrotask(() => {
      // The runtime learns of the server first, so it is reachable when the program is told; not of
      // one closed in the meantime (listen() then close() in one tick): its 'closed' has gone up already.
      if (this.listening) serverEvents.emit('listening', this.port, this.ephemeral);
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
    serverEvents.emit('closed', this.port);
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

  /**
   * Called by the runtime for each bridged request. Returns what aborts it: the client went away
   * before the response ended (its process died), and its connection closes.
   */
  dispatch(method: string, url: string, headers: [string, string][], body: Uint8Array | null, bridge: BridgeResponse): () => void {
    // Requests surfaced in a service worker carry no Content-Length; a real connection would.
    // Body parsers (e.g. Express') use it to decide whether a request has a body.
    if (body && !headers.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k))) headers = [...headers, ['content-length', String(body.length)]];
    const req = new IncomingMessage(method, url, headers, typeof this.port === 'number' ? this.port : 0);
    const socket = req.socket as FakeSocket;
    socket.server = this;
    const res = new ServerResponse(req, bridge);
    // The connection closed before the response ended (the client went away, res.destroy(),
    // req.socket.destroy()): as Node's abortIncoming, the request is destroyed ('aborted' if it was not
    // read to its end; its 'error' and 'close' later) and the response closes at once.
    socket.once('close', () => {
      if (res.finished) return;
      req.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      res.connectionClosed();
    });
    if (body?.length) req.push(Buffer.from(body));
    req.push(null);
    req.complete = true;
    this.emit('request', req, res);
    return () => void socket.destroy();
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

function createServer(opts?: unknown, handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  return new Server(opts, handler);
}

// --- client -------------------------------------------------------------------------

class Agent extends EventEmitter {
  options: Record<string, unknown>;
  maxSockets: number;
  sockets = {};
  requests = {};
  freeSockets = {};
  /** Requests going on to each host, and those waiting for one of its maxSockets (as for a free socket). */
  private busy = new Map<string, number>();
  private waiting = new Map<string, (() => void)[]>();
  constructor(opts: Record<string, unknown> = {}) {
    super();
    this.options = opts;
    this.maxSockets = typeof opts.maxSockets === 'number' ? opts.maxSockets : Infinity;
  }
  destroy() {}
  /** Runs `go` once one of `host`'s sockets is free (see free). */
  take(host: string, go: () => void) {
    const n = this.busy.get(host) ?? 0;
    if (n < this.maxSockets) {
      this.busy.set(host, n + 1);
      return go();
    }
    const waiting = this.waiting.get(host) ?? [];
    waiting.push(go);
    this.waiting.set(host, waiting);
  }
  /** A request to `host` is over: the next one waiting goes on its socket. */
  free(host: string) {
    const next = this.waiting.get(host)?.shift();
    if (next) return next();
    const n = (this.busy.get(host) ?? 1) - 1;
    if (n > 0) this.busy.set(host, n);
    else this.busy.delete(host);
  }
}
const globalAgent = new Agent();

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
  /** Its response, once it has one. */
  private res: IncomingMessage | null = null;
  /** An agent with a socket limit (maxSockets): the request waits for one of its sockets. */
  agent: Agent | null = null;
  /** Tells its server (on this machine) that its client went away. */
  #cancelServer: (() => void) | null = null;
  /** setTimeout's: 'timeout' once it has been idle that long (0: never), and its timer. */
  #timeoutMs = 0;
  /** It has its socket (see #assigned), its body is written (_final: what to send), and its 'timeout' came. */
  #hasSocket = false;
  #body: { data: ReturnType<typeof Buffer.concat> | undefined } | null = null;
  #timedOut = false;
  #timer: ReturnType<typeof timers.setTimeout> | undefined;
  aborted = false;
  constructor(url: string, method: string, headers: Record<string, string>, cb?: (res: IncomingMessage) => void, socketPath?: string, agent?: Agent) {
    // Not destroyed once its body is written (the stream's autoDestroy): that would abort its fetch().
    super({ autoDestroy: false });
    const u = new URL(url);
    this.url = url;
    this.target = socketPath ?? (LOCAL_HOSTS.has(u.hostname) ? Number(u.port || (u.protocol === 'https:' ? 443 : 80)) : null);
    // As in Node, the request gets its (connected) socket on a later tick; proxies (httpxy) wait for it.
    this.socket = this.connection = Object.assign(new FakeSocket(0), { pending: false, connecting: false });
    this.method = method;
    this.path = u.pathname + u.search;
    this.host = u.host;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    if (cb) this.once('response', cb);
    this.once('close', () => timers.clearTimeout(this.#timer));
    // With an agent's socket limit (maxSockets), once one of its sockets is free, in the order the
    // requests were made; a request made and never ended keeps its socket, as in Node.
    if (agent && agent.maxSockets !== Infinity) {
      this.agent = agent;
      agent.take(this.host, () => {
        if (this.destroyed) return agent.free(this.host);
        this.once('close', () => agent.free(this.host));
        queueMicrotask(() => this.#assigned());
      });
    } else queueMicrotask(() => this.#assigned());
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
  /** As Node's: 'timeout' (with `cb`) once the request has been idle `ms`; the program decides what to do. */
  setTimeout(ms: number, cb?: () => void) {
    if (cb) this.once('timeout', cb);
    this.#timeoutMs = ms;
    this.#active();
    return this;
  }
  /** Something came (or the timeout was set): its idle time starts over. */
  /** Its socket: the request goes out once its body is written too, and its timeout starts. */
  #assigned() {
    if (this.destroyed) return;
    this.#hasSocket = true;
    this.emit('socket', this.socket);
    this.#active();
    if (this.#body) this.#send(this.#body.data);
  }
  #active() {
    timers.clearTimeout(this.#timer);
    // As Node's (its socket's 'timeout', once): from when it has its socket, and only once.
    if (this.#timeoutMs <= 0 || !this.#hasSocket || this.#timedOut || this.destroyed) return void (this.#timer = undefined);
    this.#timer = timers.setTimeout(() => {
      this.#timedOut = true;
      this.emit('timeout');
    }, this.#timeoutMs);
  }
  setNoDelay() {}
  setSocketKeepAlive() {}
  flushHeaders() {}
  /** As Node's: destroys the request without an error, and emits 'abort' (before what aborting its response emits). */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    // Destroyed in this tick once it had its socket: 'abort' comes before the error and 'close' to come.
    if (this.destroyed && this.#hasSocket) return void this.emit('abort');
    // First, with a response in flight or a socket (before what destroying it emits); else after its 'close'.
    const first = (this.res && !this.res.complete && !this.res.destroyed) || this.#hasSocket;
    if (first) queueMicrotask(() => this.emit('abort'));
    this.destroy();
    if (!first) queueMicrotask(() => this.emit('abort'));
  }
  /**
   * As Node's: before its response, the request fails ("socket hang up" unless `err`); once it has a
   * response in flight, that is aborted (the request closes, the response errors); once its response
   * ended, it only closes.
   */
  destroy(err?: Error) {
    if (this.destroyed) return this;
    this.controller.abort();
    const res = this.res;
    // Its server learns its client went away (as a real one does from the connection's end).
    if (!res?.complete) this.#cancelServer?.();
    if (!res) {
      if (err) return super.destroy(err);
      // As Node's: once it has its socket, it failed ("socket hang up"), aborted or not; before, unless
      // it is aborted in the same tick (then it was only aborted).
      if (this.#hasSocket) return super.destroy(connectionReset('socket hang up'));
      queueMicrotask(() => {
        if (!this.aborted) this.emit('error', connectionReset('socket hang up'));
      });
      return super.destroy();
    }
    if (!res.complete && !res.destroyed) return this.abortResponse(res, err);
    return super.destroy(err);
  }
  /** Closes the request, once (not aborting its fetch(), as destroy() does). */
  private finish(err?: Error) {
    if (!this.destroyed) super.destroy(err);
  }
  /** Its response came: the request closes once it ends, or once it closes (destroyed by the program). */
  private respond(status: number, statusText: string, headers: [string, string][]): IncomingMessage | null {
    if (this.destroyed) return null;
    const res = (this.res = new IncomingMessage(this.method, this.path, headers, 0));
    res.statusCode = status;
    res.statusMessage = statusText;
    res.once('end', () => this.finish());
    res.once('close', () => {
      // Destroyed before its end: what is still coming is not read, and its server learns it.
      if (!res.complete) {
        this.controller.abort();
        this.#cancelServer?.();
      }
      queueMicrotask(() => this.finish());
    });
    this.#active();
    // As Node's: a response nobody listens for is read and dropped (so its request closes).
    if (!this.emit('response', res)) res.resume();
    return res;
  }
  /**
   * The response in flight is cut short (its server went away, or the program destroyed the request),
   * as in Node: the request's error (if any), the response's 'aborted', the request's 'close', then the
   * response's 'error' and 'close'.
   */
  private abortResponse(res: IncomingMessage, err?: Error) {
    res.aborted = true;
    queueMicrotask(() => {
      if (err) this.emit('error', err);
      res.emit('aborted');
    });
    super.destroy();
    res.destroy(connectionReset('aborted'));
    return this;
  }
  _write(chunk: unknown, enc: BufferEncoding, cb: () => void) {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : (chunk as Uint8Array));
    cb();
  }
  /** Delivers the request to a server on this machine, if there is one. */
  private local(body: Uint8Array | null): boolean {
    let res: IncomingMessage | null = null;
    const bridge = {
      start: (status: number, statusText: string, headers: [string, string][]) => void (res = this.respond(status, statusText, headers)),
      chunk: (data: Uint8Array) => {
        if (!res || res.destroyed) return;
        this.#active();
        res.push(Buffer.from(data));
      },
      end: () => {
        if (res && !res.destroyed) {
          res.complete = true;
          res.push(null);
        }
      },
      error: (message: string, code = 'ECONNRESET') => {
        if (!res) return this.finish(Object.assign(new Error(message), { code }));
        // The server went away mid-response (its process crashed): the response is cut short, as in Node.
        if (!res.complete && !res.destroyed) this.abortResponse(res);
      },
    };
    const headers: [string, string][] = Object.entries(this.headers);
    if (!('host' in this.headers)) headers.push(['host', this.host || 'localhost']);
    const server = servers.get(this.target!);
    if (server) {
      let abort: (() => void) | null = null;
      queueMicrotask(() => {
        if (!this.destroyed) abort = server.dispatch(this.method, this.path, headers, body, bridge);
      });
      this.#cancelServer = () => abort?.();
      return true;
    }
    const cancel = loopback.route?.(this.target!, this.method, this.path, headers, body, bridge);
    if (!cancel) return false;
    this.#cancelServer = cancel;
    return true;
  }
  _final(cb: () => void) {
    this.#body = { data: this.chunks.length ? Buffer.concat(this.chunks) : undefined };
    if (this.#hasSocket) this.#send(this.#body.data);
    cb();
  }
  #send(body: ReturnType<typeof Buffer.concat> | undefined) {
    if (this.target !== null && this.local(body ?? null)) return;
    fetch(this.url, { method: this.method, headers: this.headers, body: this.method === 'GET' || this.method === 'HEAD' ? undefined : body, signal: this.controller.signal, redirect: 'manual' })
      .then(
        async (r) => {
          const headers: [string, string][] = [];
          r.headers.forEach((v, k) => headers.push([k, v]));
          const msg = this.respond(r.status, r.statusText, headers);
          if (!msg) return;
          const reader = r.body?.getReader();
          try {
            for (;;) {
              const read = await reader?.read();
              if (!read || read.done) break;
              this.#active();
              msg.push(Buffer.from(read.value));
            }
          } catch {
            // Cut short (the connection broke, or the program destroyed it: then it is aborted already).
            if (!msg.complete && !msg.destroyed) this.abortResponse(msg);
            return;
          }
          // Read to its end: complete (else, destroyed as it ends, it would be 'aborted').
          msg.complete = true;
          msg.push(null);
        },
        // Not when the program destroyed it (destroy() says how it failed).
        (e) => this.finish(Object.assign(new Error((e as Error)?.message ?? String(e), { cause: e }), { code: 'ECONNREFUSED' })),
      );
  }
}

const connectionReset = (message: string) => Object.assign(new Error(message), { code: 'ECONNRESET' });

function makeClient(defaultProtocol: 'http:' | 'https:') {
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
    const req = new ClientRequest(url, ((o.method as string) ?? 'GET').toUpperCase(), (o.headers as Record<string, string>) ?? {}, cb, typeof o.socketPath === 'string' ? o.socketPath : undefined, o.agent instanceof Agent ? o.agent : undefined);
    if (typeof o.timeout === 'number') req.setTimeout(o.timeout);
    return req;
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
