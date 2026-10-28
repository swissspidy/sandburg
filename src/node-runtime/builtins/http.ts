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
import { ExitError, onClosePhase, onPeerPhase, timers } from './process.ts';

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
  /** The server read this many bytes of a streamed request body: its client may send as many more (see BODY_WINDOW). */
  consumed?(bytes: number): void;
  /**
   * How long the client keeps the connection once the response ended (as a Node agent does, see
   * Agent.idleTimeout): 0 closes it then, null keeps it as long as the server does. Unset: the page's
   * requests, whose connection the browser keeps longer than a server.
   */
  idle?: number | null;
}

/** A request whose body comes after its headers, chunk by chunk (see ClientRequest#open). */
export const STREAMED = 'stream' as const;

/** What a dispatched request's server is given more of: its body (when STREAMED), and that its client went away. */
export interface Dispatched {
  /** The client went away before the response ended: its connection closes. */
  abort(): void;
  /** A chunk of its body, and its end. */
  write(chunk: Uint8Array): void;
  end(): void;
}

/** A request on its way to a server on this machine: its body (when STREAMED), and that its client went away. */
export interface Outgoing {
  write(chunk: Uint8Array): void;
  end(): void;
  cancel(): void;
}

/**
 * Body bytes a client sends before its server has read them, at most: then its writes wait (and
 * write() returns false), as a socket's do once the connection's buffers are full.
 */
const BODY_WINDOW = 64 * 1024;

/** Listening servers by port, or by path for servers on a local socket; the runtime's request dispatcher reads this. */
export const servers = new Map<number | string, Server>();
export const serverEvents = new EventEmitter();

/**
 * Requests to this machine (localhost, or a socketPath) are delivered to virtual servers directly,
 * without the network: this runtime's own (`servers`), and through `loopback.route` those of other
 * runtimes (threads, child processes: see worker.ts). Anything else goes through fetch().
 */
export const loopback: {
  /** Routes a request to another runtime's server: false if there is none, else what sends it its body and tells it its client went away. */
  route?(target: number | string, method: string, url: string, headers: [string, string][], body: Uint8Array | null | typeof STREAMED, bridge: BridgeResponse & { error(message: string, code?: string): void }): false | Outgoing;
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
  /** What the program wrote to the socket itself (a 'clientError' listener's raw response), for the server to send (see Server.dispatch). */
  written: Uint8Array[] = [];
  /** Tells the other end of the connection, as it is destroyed. */
  onDestroy: (() => void) | null = null;
  /** setTimeout's: 'timeout' once the connection has been idle that long (0: never), and its timer. */
  #timeoutMs = 0;
  #timer: ReturnType<typeof timers.setTimeout> | undefined;
  constructor(port: number) {
    super();
    this.localPort = port;
  }
  get timeout() { return this.#timeoutMs || undefined; }
  /** As net.Socket's: 'timeout' once nothing was read or written for `ms` (see active), again after more comes; 0 stops it. */
  setTimeout(ms: number, cb?: () => void) {
    if (cb) {
      if (ms === 0) this.removeListener('timeout', cb);
      else this.once('timeout', cb);
    }
    this.#timeoutMs = ms;
    this.active();
    return this;
  }
  /** Something was read or written: its idle time starts over. Its timer does not keep the process alive. */
  active() {
    timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#timeoutMs <= 0 || this.destroyed) return;
    this.#timer = timers.setTimeout(() => {
      this.#timer = undefined;
      this.emit('timeout');
    }, this.#timeoutMs).unref();
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.localPort }; }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = this.writable = false;
    timers.clearTimeout(this.#timer);
    this.onDestroy?.();
    // As a real socket's: once the handle closed, after what this turn queued.
    onClosePhase(() => this.emit('close'));
    return this;
  }
  end(data?: unknown, encoding?: unknown) {
    if (data !== undefined && typeof data !== 'function') this.write(data, encoding);
    return this.destroy();
  }
  write(data?: unknown, encoding?: unknown) {
    if (!this.destroyed && (typeof data === 'string' || data instanceof Uint8Array)) this.written.push(typeof data === 'string' ? Buffer.from(data, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8') : data);
    return true;
  }
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
  setTimeout(_ms?: number, _cb?: () => void) { return this; }
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
  /** The program wants more of its body (see Server.dispatch: the client may send more). */
  pull: (() => void) | null = null;
  _read() {
    this.pull?.();
  }
  /** As Node's: its connection's idle timeout (a server's request gets 'timeout' while its body is still coming). */
  setTimeout(ms: number, cb?: () => void) {
    if (cb) this.on('timeout', cb);
    this.socket.setTimeout(ms);
    return this;
  }
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
    // As Node: an error is emitted only to listeners ('aborted' and 'close' tell the others); it settles
    // a tick later, when it was aborted with its connection still open (which it closes) or failed.
    const settle = () => cb(this.listenerCount('error') ? err : null);
    if (err || (this.aborted && !this.socket.destroyed)) queueMicrotask(settle);
    else settle();
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
    if (!held) return;
    for (const out of held) out();
    this.socket.active();
  }
  /** A 'clientError' to come ('pending'), and with its 'close' held until it came ('close'). */
  private clientError: 'pending' | 'close' | null = null;
  /** Its connection closed before it ended (see Server.dispatch): it closes at once. */
  connectionClosed() {
    this.destroy();
    this.emitCloseOnce();
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
  /** As Node's: its connection's idle timeout ('timeout' on it, with `cb`, the request and the server: see Server.dispatch). */
  setTimeout(ms: number, cb?: () => void) {
    if (cb) this.on('timeout', cb);
    this.socket.setTimeout(ms);
    return this;
  }
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
    this.socket.active();
    cb();
    // As Node's (its 'finish' listener queues it): a tick after the request's own 'close'.
    queueMicrotask(() => queueMicrotask(() => this.emitCloseOnce()));
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
  /** As Node's: a connection's idle timeout (0: none), for connections from then on. */
  timeout = 0;
  keepAliveTimeout = 5000;
  keepAliveTimeoutBuffer = 1000;
  requestTimeout = 300000;
  headersTimeout = 60000;
  /** How often requests whose body is still coming are checked against requestTimeout (see #checkRequests). */
  connectionsCheckingInterval = 30000;
  maxHeadersCount: number | null = null;
  /** Requests whose body is still coming, and since when (for requestTimeout). */
  #incoming = new Map<IncomingMessage, { since: number; expire(): void }>();
  #checking: ReturnType<typeof timers.setInterval> | undefined;
  constructor(opts?: unknown, handler?: (req: IncomingMessage, res: ServerResponse) => void) {
    super();
    const h = typeof opts === 'function' ? opts : handler;
    if (h) this.on('request', h as never);
    const o = (typeof opts === 'object' && opts) || {};
    const int = (name: string) => {
      const v = (o as Record<string, unknown>)[name];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw Object.assign(new RangeError(`The value of "options.${name}" is out of range. It must be >= 0 && <= 9007199254740991. Received ${String(v)}`), { code: typeof v === 'number' ? 'ERR_OUT_OF_RANGE' : 'ERR_INVALID_ARG_TYPE' });
      return v;
    };
    this.requestTimeout = int('requestTimeout') ?? 300000;
    // As Node's: at most requestTimeout by default.
    this.headersTimeout = int('headersTimeout') ?? Math.min(60000, this.requestTimeout);
    this.keepAliveTimeout = int('keepAliveTimeout') ?? 5000;
    this.keepAliveTimeoutBuffer = int('keepAliveTimeoutBuffer') ?? 1000;
    this.connectionsCheckingInterval = int('connectionsCheckingInterval') ?? 30000;
    if (this.requestTimeout > 0 && this.headersTimeout > 0 && this.headersTimeout > this.requestTimeout) {
      throw Object.assign(new RangeError(`The value of "headersTimeout" is out of range. It must be <= requestTimeout. Received ${this.headersTimeout}`), { code: 'ERR_OUT_OF_RANGE' });
    }
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
      // As Node's: requests are checked against requestTimeout from now, by a timer that does not keep the process alive.
      timers.clearInterval(this.#checking);
      if (this.listening) this.#checking = timers.setInterval(() => this.#checkRequests(), this.connectionsCheckingInterval).unref();
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
    timers.clearInterval(this.#checking);
    this.#checking = undefined;
    serverEvents.emit('closed', this.port);
    queueMicrotask(() => {
      this.emit('close');
      cb?.();
    });
    return this;
  }
  closeAllConnections() {}
  closeIdleConnections() {}
  /** As Node's: the idle timeout of connections from now on, and `cb` for their 'timeout'. */
  setTimeout(ms?: number, cb?: () => void) {
    if (typeof ms === 'function') [ms, cb] = [undefined, ms];
    if (ms !== undefined) this.timeout = ms;
    if (cb) this.on('timeout', cb);
    return this;
  }
  ref() { return this; }
  unref() { return this; }
  getConnections(cb: (e: null, n: number) => void) { cb(null, 0); }

  /**
   * As Node's checkConnections: a request whose body is still coming after requestTimeout fails
   * (408). As measured in Node 24, a request with its headers expires after the longer of
   * requestTimeout and headersTimeout (headers always come whole here: headersTimeout has nothing else to time).
   */
  #checkRequests() {
    const valid = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);
    const requestTimeout = valid(this.requestTimeout);
    if (!requestTimeout) return;
    const limit = Math.max(requestTimeout, valid(this.headersTimeout));
    const now = performance.now();
    for (const [req, { since, expire }] of [...this.#incoming]) {
      if (now - since <= limit) continue;
      this.#incoming.delete(req);
      expire();
    }
  }

  /**
   * Called by the runtime for each bridged request, with its whole body, or with STREAMED for one
   * whose body comes after (Dispatched.write and end). Returns what gives the server the rest of it,
   * and what aborts it: the client went away before the response ended, and its connection closes.
   */
  dispatch(method: string, url: string, headers: [string, string][], body: Uint8Array | null | typeof STREAMED, bridge: BridgeResponse): Dispatched {
    const streamed = body === STREAMED;
    // Requests surfaced in a service worker carry no Content-Length; a real connection would.
    // Body parsers (e.g. Express') use it to decide whether a request has a body.
    if (body && !streamed && !headers.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k))) headers = [...headers, ['content-length', String(body.length)]];
    const req = new IncomingMessage(method, url, headers, typeof this.port === 'number' ? this.port : 0);
    const socket = req.socket as FakeSocket;
    socket.server = this;
    const res = new ServerResponse(req, bridge);
    // The connection is closed before the response ended (res.destroy(), req.socket.destroy(), a
    // timeout): its client hears it, as it is (see onPeerPhase): what the program wrote to the socket
    // itself (a 'clientError' listener's response), else the reset.
    socket.onDestroy = () => {
      if (res.finished || (!res.headersSent && sendWritten(socket.written, bridge))) return;
      bridge.error?.('socket hang up', 'ECONNRESET');
    };
    // Once it closed (or the client went away): as Node's abortIncoming, the request is destroyed
    // ('aborted' if it was not read to its end; its 'error' and 'close' later), and the response closes at once.
    socket.once('close', () => {
      this.#incoming.delete(req);
      if (res.finished) return;
      req.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      res.connectionClosed();
    });
    // As Node's socketOnTimeout: the connection's idle timeout is the request's (while its body is
    // coming), the response's (until it ended) and the server's to handle; else the connection closes.
    let detached = false;
    res.once('finish', () => (detached = true));
    socket.on('timeout', () => {
      const reqTimeout = !req.complete && req.emit('timeout', socket);
      const resTimeout = !detached && res.emit('timeout', socket);
      const serverTimeout = this.emit('timeout', socket);
      if (!reqTimeout && !resTimeout && !serverTimeout) socket.destroy();
    });
    if (this.timeout) socket.setTimeout(this.timeout);
    // Once the response ended, the connection is idle: as Node's, kept alive for keepAliveTimeout (its
    // 'timeout' then the server's), or less long by its client (an agent's, see Agent.idleTimeout).
    res.once('finish', () => {
      if (socket.destroyed) return;
      const keepAlive = Number.isFinite(this.keepAliveTimeout) && this.keepAliveTimeout >= 0 ? this.keepAliveTimeout : 0;
      const buffer = Number.isFinite(this.keepAliveTimeoutBuffer) && this.keepAliveTimeoutBuffer >= 0 ? this.keepAliveTimeoutBuffer : 1000;
      const client = bridge.idle === undefined ? null : clientIdle(bridge.idle, keepAlive);
      if (client === 0 || /^close$/i.test(String(req.headers.connection ?? ''))) return void socket.destroy();
      if (keepAlive) socket.setTimeout(keepAlive + buffer);
      if (client !== null) timers.setTimeout(() => socket.destroy(), client).unref();
    });
    const expire = () => {
      // As Node's onRequestTimeout (socketOnError): the server's 'clientError' handles it; else a 408, and the connection closes.
      const err = Object.assign(new Error('Request timeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' });
      if (this.emit('clientError', err, socket)) return;
      if (!res.headersSent) socket.write('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    /** Body bytes it took that the program has not read yet (they are acknowledged as it reads: see BridgeResponse.consumed). */
    let unread = 0;
    if (streamed) {
      this.#incoming.set(req, { since: performance.now(), expire });
      req.pull = () => {
        if (!unread) return;
        const n = unread;
        unread = 0;
        bridge.consumed?.(n);
      };
    } else {
      if (body?.length) req.push(Buffer.from(body));
      req.push(null);
      req.complete = true;
    }
    this.emit('request', req, res);
    return {
      // Its client went away: the connection closes (and nothing goes back to it).
      abort: () => {
        socket.onDestroy = null;
        socket.destroy();
      },
      write: (chunk) => {
        if (!streamed || req.complete || req.destroyed) return;
        socket.active();
        if (req.push(Buffer.from(chunk))) bridge.consumed?.(chunk.length);
        else unread += chunk.length;
      },
      end: () => {
        if (!streamed || req.complete || req.destroyed) return;
        this.#incoming.delete(req);
        socket.active();
        req.complete = true;
        req.push(null);
      },
    };
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

/**
 * How long a Node agent keeps a connection once its response ended (Agent.keepSocketAlive): its own
 * timeout (`idle`: null for none, 0 for no keeping), shortened to a second less than the server's
 * Keep-Alive hint (whole seconds of its keepAliveTimeout), and closed at once when that is none.
 * null: as long as the server keeps it.
 */
function clientIdle(idle: number | null, keepAliveTimeout: number): number | null {
  if (idle === 0) return 0;
  // No hint without a keepAliveTimeout; a hint of none closes it; it only shortens the agent's own timeout.
  if (!keepAliveTimeout) return idle;
  const hint = Math.floor(keepAliveTimeout / 1000) * 1000 - 1000;
  if (hint <= 0) return 0;
  return idle !== null && hint < idle ? hint : idle;
}

/**
 * A response the program wrote to a connection itself (a 'clientError' listener's
 * `socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')`, or Node's own 408) goes to its client as one.
 */
function sendWritten(written: Uint8Array[], bridge: BridgeResponse): boolean {
  if (!written.length) return false;
  const bytes = Buffer.concat(written);
  const end = bytes.indexOf('\r\n\r\n');
  const head = bytes.subarray(0, end < 0 ? bytes.length : end).toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(head[0]);
  if (!status || end < 0) return false;
  const headers: [string, string][] = [];
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  bridge.start(Number(status[1]), status[2] ?? '', headers);
  const rest = bytes.subarray(end + 4);
  if (rest.length) bridge.chunk(new Uint8Array(rest));
  bridge.end();
  return true;
}

function createServer(opts?: unknown, handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  return new Server(opts, handler);
}

// --- client -------------------------------------------------------------------------

class Agent extends EventEmitter {
  options: Record<string, unknown>;
  maxSockets: number;
  keepAlive: boolean;
  sockets = {};
  requests = {};
  freeSockets = {};
  /** Requests going on to each host, and those waiting for one of its maxSockets (as for a free socket). */
  private busy = new Map<string, number>();
  private waiting = new Map<string, (() => void)[]>();
  constructor(opts: Record<string, unknown> = {}) {
    super();
    this.options = { path: null, ...opts };
    this.maxSockets = typeof opts.maxSockets === 'number' ? opts.maxSockets : Infinity;
    this.keepAlive = !!opts.keepAlive;
  }
  /**
   * How long it keeps a connection once its response ended (see clientIdle): 0 when it does not keep
   * connections alive (its requests ask for Connection: close), else its timeout, null for none.
   */
  get idleTimeout(): number | null {
    if (!this.keepAlive) return 0;
    return typeof this.options.timeout === 'number' && this.options.timeout > 0 ? this.options.timeout : null;
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
/** As Node 24's: it keeps connections alive, for 5 s at most. */
const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });

/** Methods whose body Node frames by default (chunked, or with its length); others send none unless given a length. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'PROPFIND', 'PROPPATCH', 'REPORT', 'SEARCH', 'MKCOL', 'LOCK', 'UNLOCK', 'COPY', 'MOVE', 'MERGE', 'PURGE', 'LINK', 'UNLINK', 'ACL', 'BIND', 'REBIND', 'UNBIND', 'MKACTIVITY', 'CHECKOUT', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE', 'M-SEARCH', 'MKCALENDAR', 'QUERY', 'SOURCE']);

class ClientRequest extends Writable {
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
  /** How long its agent keeps the connection once the response ended (see Agent.idleTimeout). */
  #idle: number | null;
  /** setTimeout's: 'timeout' once it has been idle that long (0: never), and its timer. */
  #timeoutMs = 0;
  #timedOut = false;
  #timer: ReturnType<typeof timers.setTimeout> | undefined;
  /** It has its socket (see #assigned). */
  #hasSocket = false;
  /** Its headers are to go out (it was written to, flushed or ended), and they went (#open): to a server here, or by fetch() ('fetch', at its end). */
  #started = false;
  #out: Outgoing | 'fetch' | null = null;
  /**
   * How its body is framed, as Node's: chunked (each chunk as it was written), with its length (when
   * it was ended before anything was written, or the program set one: what is written in a tick goes
   * together), or not at all (a GET's without a length: it does not go out). Set as its headers are.
   */
  #framing: 'chunked' | 'length' | 'none' = 'length';
  /** end() is being called before anything was written: its body is all there is (its length is known). */
  #ending = false;
  /** Chunks written in this tick, with its length (see #framing): they go together. */
  #batch: Uint8Array[] = [];
  /** What it was written before its headers went out (and for fetch(), all of it). */
  #pending: Uint8Array[] = [];
  /** It was ended; _final's callback ('finish') waits until its body went out. */
  #ended = false;
  #finalCb: (() => void) | null = null;
  /** Body bytes its server has not read yet (see BODY_WINDOW), and the write waiting for it to. */
  #unread = 0;
  #heldWrite: (() => void) | null = null;
  /** What destroy(err) was given; an error went out already; its connection closed; 'close' was emitted. */
  #error: Error | undefined;
  #hadError = false;
  #socketClosed = false;
  #closed = false;
  /** The program destroyed it (not its server, see #reset). */
  #gone = false;
  /** Tells its server (on this machine) that its client went away. */
  #cancelServer: (() => void) | null = null;
  aborted = false;
  headersSent = false;
  constructor(url: string, method: string, headers: Record<string, string>, cb?: (res: IncomingMessage) => void, socketPath?: string, agent?: Agent | false) {
    // Not destroyed once its body is written (the stream's autoDestroy): that would abort its fetch().
    // Its 'close' is its connection's (see #emitClose).
    super({ autoDestroy: false, emitClose: false });
    const u = new URL(url);
    this.url = url;
    this.target = socketPath ?? (LOCAL_HOSTS.has(u.hostname) ? Number(u.port || (u.protocol === 'https:' ? 443 : 80)) : null);
    // As in Node, the request gets its (connected) socket on a later tick; proxies (httpxy) wait for it.
    this.socket = this.connection = Object.assign(new FakeSocket(0), { pending: false, connecting: false });
    this.method = method;
    this.path = u.pathname + u.search;
    this.host = u.host;
    this.#idle = agent === false ? 0 : (agent ?? globalAgent).idleTimeout;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    if (cb) this.once('response', cb);
    this.once('close', () => timers.clearTimeout(this.#timer));
    // With an agent's socket limit (maxSockets), once one of its sockets is free, in the order the
    // requests were made; a request made and never ended keeps its socket, as in Node.
    if (agent && agent.maxSockets !== Infinity) {
      this.agent = agent;
      agent.take(this.host, () => {
        this.once('close', () => agent.free(this.host));
        queueMicrotask(() => this.#assigned());
      });
    } else queueMicrotask(() => this.#assigned());
  }
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
  /**
   * Its socket (as Node's onSocketNT): the request goes out once it was written to or ended, and its
   * timeout starts; destroyed before, it fails now ("socket hang up" unless it was aborted) and closes.
   */
  #assigned() {
    if (this.destroyed) {
      const err = this.#error ?? (this.aborted ? undefined : connectionReset('socket hang up'));
      if (err) this.emit('error', err);
      return this.#emitClose();
    }
    this.#hasSocket = true;
    this.emit('socket', this.socket);
    if (this.destroyed) return;
    this.#active();
    if (this.#started) this.#open();
  }
  /** Something came (or the timeout was set): its idle time starts over. */
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
  /** As Node's: its headers go out now (once it has its socket), before its body. */
  flushHeaders() {
    this.#start();
  }
  /** As Node's: destroys the request (see destroy), and emits 'abort' on the next tick. */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.emit('abort'));
    this.destroy();
  }
  /**
   * As Node's: destroyed with its socket, its connection closes, and what that emits comes as the
   * socket's 'close' does (after what this turn queued: see onClosePhase): before its response, the
   * request fails ("socket hang up" unless `err`, which comes first); with a response in flight, that
   * is aborted. Before its socket, it fails once it gets it (#assigned); once its response ended, nothing is left to do.
   */
  destroy(err?: Error) {
    if (this.destroyed) return this;
    super.destroy();
    this.#gone = true;
    this.controller.abort();
    this.#heldWrite = null;
    if (this.#ended && this.res?.complete) return this;
    this.#error = err;
    if (!this.#hasSocket) return this;
    // Its server (on this machine) learns it as from its end of the connection.
    this.#cancelServer?.();
    if (err) {
      this.#hadError = true;
      queueMicrotask(() => this.emit('error', err));
    }
    onClosePhase(() => this.#connectionClosed());
    return this;
  }
  #emitClose() {
    if (this.#closed) return;
    this.#closed = true;
    const state = (this as unknown as { _writableState: { closed: boolean; closeEmitted: boolean } })._writableState;
    state.closed = state.closeEmitted = true;
    this.emit('close');
  }
  /**
   * Its connection closed (as Node's socketCloseListener): a response in flight is aborted, else the
   * request failed ("socket hang up", unless it failed already); it closes. Its server (on this machine) learns it after.
   */
  #connectionClosed() {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    if (!this.destroyed) super.destroy();
    const res = this.res;
    if (res) {
      if (!res.complete) res.destroy(connectionReset('aborted'));
      this.#emitClose();
      if (!res.aborted && res.readable) res.push(null);
    } else {
      if (!this.#hadError) {
        this.#hadError = true;
        this.emit('error', connectionReset('socket hang up'));
      }
      this.#emitClose();
    }
  }
  /** Its connection broke (its server went away, or could not be reached): `err` comes first, then the rest as its socket closes. */
  #reset(err?: Error) {
    if (this.#socketClosed || this.#closed) return;
    if (!this.destroyed) super.destroy();
    if (err && !this.#hadError) {
      this.#hadError = true;
      this.emit('error', err);
    }
    onClosePhase(() => this.#connectionClosed());
  }
  /** Its response came: the request closes once it ends, or once it closes (destroyed by the program). */
  private respond(status: number, statusText: string, headers: [string, string][]): IncomingMessage | null {
    if (this.destroyed) return null;
    const res = (this.res = new IncomingMessage(this.method, this.path, headers, 0));
    res.statusCode = status;
    res.statusMessage = statusText;
    // As Node's: it closes after what the response's 'end' listeners do.
    res.once('end', () => {
      if (!this.destroyed) super.destroy();
      queueMicrotask(() => this.#emitClose());
    });
    res.once('close', () => {
      // Destroyed before its end (by the program): its connection closes, what is still coming is not read, and its server learns it.
      if (res.complete || this.#socketClosed) return;
      this.#gone = true;
      this.controller.abort();
      this.#cancelServer?.();
      onClosePhase(() => this.#connectionClosed());
    });
    this.#active();
    // As Node's: a response nobody listens for is read and dropped (so its request closes).
    if (!this.emit('response', res)) res.resume();
    return res;
  }
  /** Its headers are to go out (with how its body is framed): they do once it has its socket. */
  #start() {
    if (!this.#started) {
      this.#started = this.headersSent = true;
      if ('transfer-encoding' in this.headers) this.#framing = /chunked/i.test(this.headers['transfer-encoding']) ? 'chunked' : 'length';
      else if ('content-length' in this.headers) this.#framing = 'length';
      else if (!BODY_METHODS.has(this.method)) this.#framing = 'none';
      else this.#framing = this.#ending ? 'length' : 'chunked';
    }
    if (this.#hasSocket && !this.#out && !this.destroyed) this.#open();
  }
  // Node's req.end(data, encoding, cb) also accepts (cb) and (data, cb).
  end(...args: unknown[]) {
    if (!this.#started && !this.writableEnded) this.#ending = true;
    return super.end(...(args as []));
  }
  _write(chunk: unknown, enc: BufferEncoding, cb: () => void) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, enc) : (chunk as Uint8Array);
    // Before its headers went out, with what it is written (they may go out now, see #open).
    if (!this.#out) {
      if (bytes.length) this.#pending.push(bytes);
      this.#start();
      return cb();
    }
    const out = this.#out;
    if (this.#framing === 'none' || !bytes.length) return cb();
    if (out === 'fetch') {
      this.#pending.push(bytes);
      return cb();
    }
    this.#sendBody(out, bytes);
    // As a socket's: once its server is that far behind, the next write waits for it to read.
    if (this.#unread > BODY_WINDOW) this.#heldWrite = cb;
    else cb();
  }
  #sendBody(out: Outgoing, bytes: Uint8Array) {
    this.#unread += bytes.length;
    // A copy: the program may reuse what it wrote once write() returned.
    if (this.#framing === 'chunked') return out.write(new Uint8Array(bytes));
    this.#batch.push(new Uint8Array(bytes));
    if (this.#batch.length === 1) queueMicrotask(() => this.#flushBatch());
  }
  #flushBatch() {
    const batch = this.#batch;
    if (!batch.length || !this.#out || this.#out === 'fetch') return;
    this.#batch = [];
    this.#out.write(batch.length === 1 ? batch[0] : new Uint8Array(Buffer.concat(batch)));
  }
  /** Its server read `n` bytes of its body. */
  #consumed(n: number) {
    this.#unread = Math.max(0, this.#unread - n);
    const cb = this.#heldWrite;
    if (cb && this.#unread <= BODY_WINDOW) {
      this.#heldWrite = null;
      cb();
    }
  }
  _final(cb: () => void) {
    this.#ended = true;
    this.#finalCb = cb;
    this.#start();
    if (this.#out) this.#finish();
  }
  /** Its body went out to its end: 'finish' (as Node's, once its socket wrote it). */
  #finish() {
    const out = this.#out;
    if (out === 'fetch') this.#fetch();
    else {
      this.#flushBatch();
      out?.end();
    }
    const cb = this.#finalCb;
    this.#finalCb = null;
    cb?.();
  }
  /**
   * Its headers go out: to a server on this machine, its body after them chunk by chunk (as Node's: with
   * its length when it was ended first, else chunked; a GET's, with neither, does not go out); else by
   * fetch(), once it ended.
   */
  #open() {
    const headers: [string, string][] = Object.entries(this.headers);
    if (!('host' in this.headers)) headers.push(['host', this.host || 'localhost']);
    if (this.target !== null) {
      if (!('connection' in this.headers)) headers.push(['connection', this.#idle === 0 ? 'close' : 'keep-alive']);
      if (!('content-length' in this.headers) && !('transfer-encoding' in this.headers)) {
        if (this.#framing === 'chunked') headers.push(['transfer-encoding', 'chunked']);
        else if (this.#framing === 'length') headers.push(['content-length', String(this.#pending.reduce((n, c) => n + c.length, 0))]);
      }
    }
    const out = this.target !== null ? this.#local(headers) : false;
    if (!out) {
      this.#out = 'fetch';
      if (this.#ended) this.#finish();
      return;
    }
    this.#out = out;
    this.#cancelServer = out.cancel;
    const pending = this.#pending;
    this.#pending = [];
    if (this.#framing !== 'none') for (const chunk of pending) this.#sendBody(out, chunk);
    if (this.#ended) this.#finish();
  }
  /** Delivers the request to a server on this machine, if there is one. */
  #local(headers: [string, string][]): Outgoing | false {
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
        // The server went away (its process crashed, it reset the connection): before a response, the
        // request fails; else the response in flight is cut short, as in Node. Not once the program closed it.
        if (this.#gone) return;
        if (!res) return this.#reset(Object.assign(new Error(message), { code }));
        if (!res.complete && !res.destroyed) this.#reset();
      },
      consumed: (n: number) => this.#consumed(n),
      idle: this.#idle,
    };
    const server = servers.get(this.target!);
    if (server) {
      // As over a connection: each end sees what the other did (the request, each chunk of its body,
      // the response, a reset) as it would from a socket, in order (see wire).
      const toServer = wire();
      const toClient = wire();
      const theirs: BridgeResponse = {
        start: (status, statusText, headers) => toClient(() => bridge.start(status, statusText, headers)),
        chunk: (data) => toClient(() => bridge.chunk(data)),
        end: () => toClient(() => bridge.end()),
        error: (message, code) => toClient(() => bridge.error(message, code)),
        flush: () => {},
        consumed: (n) => toClient(() => bridge.consumed(n)),
        idle: bridge.idle,
      };
      let dispatched: Dispatched | null = null;
      toServer(() => (dispatched = server.dispatch(this.method, this.path, headers, STREAMED, theirs)));
      return {
        write: (chunk) => toServer(() => dispatched?.write(chunk)),
        end: () => toServer(() => dispatched?.end()),
        cancel: () => toServer(() => dispatched?.abort()),
      };
    }
    return loopback.route?.(this.target!, this.method, this.path, headers, STREAMED, bridge) ?? false;
  }
  /** To a server elsewhere: through fetch(), with its whole body. */
  #fetch() {
    const body = this.#pending.length ? Buffer.concat(this.#pending) : undefined;
    this.#pending = [];
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
            if (!msg.complete && !msg.destroyed) this.#reset();
            return;
          }
          // Read to its end: complete (else, destroyed as it ends, it would be 'aborted').
          msg.complete = true;
          msg.push(null);
        },
        // Not when the program destroyed it (destroy() says how it failed).
        (e) => {
          if (!this.destroyed) this.#reset(Object.assign(new Error((e as Error)?.message ?? String(e), { cause: e }), { code: 'ECONNREFUSED' }));
        },
      );
  }
}

/**
 * One direction of a connection in this runtime: what one end does reaches the other as over a socket
 * (see onPeerPhase), in the order it was done.
 */
function wire(): (deliver: () => void) => void {
  const queue: (() => void)[] = [];
  return (deliver) => {
    queue.push(deliver);
    onPeerPhase(() => queue.shift()!());
  };
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
    const req = new ClientRequest(url, ((o.method as string) ?? 'GET').toUpperCase(), (o.headers as Record<string, string>) ?? {}, cb, typeof o.socketPath === 'string' ? o.socketPath : undefined, o.agent instanceof Agent || o.agent === false ? o.agent : undefined);
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
