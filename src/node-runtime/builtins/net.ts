/**
 * node:net for the runtime. There are no raw sockets in the browser, but programs on the same
 * machine can still talk: servers listen on virtual ports and socket paths, and connections to them
 * are pairs of streams. Tools use this for local IPC (Nuxt's vite-node socket between its server
 * worker and the Vite server, port probing). Connections to servers in other runtimes (threads,
 * child processes) go through `netLinks` (see worker.ts). Anything else is refused (ECONNREFUSED).
 */
import { EventEmitter } from 'events';
import { Duplex } from 'readable-stream';
import { Buffer } from 'buffer';
import { timers } from './process.ts';
import { servers as httpServers } from './http.ts';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const isIPv4 = (s: string) => IPV4.test(s);
export const isIPv6 = (s: string) => {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return false;
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '']);

/** The other end of a connection: a socket in this runtime, or one in another runtime. */
interface Peer {
  data(chunk: Uint8Array): void;
  end(): void;
  close(): void;
}

/**
 * Connections to servers in other runtimes. `connect` asks the runtime that has the server (the
 * parent or a nested one); `send` carries a connection's traffic.
 */
export const netLinks: {
  connect?(key: number | string, socket: Socket): boolean;
} = {};

export class Socket extends Duplex {
  remoteAddress?: string = '127.0.0.1';
  remotePort?: number;
  remoteFamily = 'IPv4';
  localAddress = '127.0.0.1';
  localPort = 0;
  connecting = false;
  pending = true;
  bytesRead = 0;
  bytesWritten = 0;
  /** Where writes go, once connected. */
  peer: Peer | null = null;
  private key: number | string | null = null;
  constructor(_opts?: unknown) {
    super({ allowHalfOpen: true } as never);
  }
  connect(...args: unknown[]) {
    const cb = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : undefined;
    const first = args[0];
    let key: number | string;
    let host = 'localhost';
    if (typeof first === 'object' && first) {
      const o = first as { path?: string; port?: number | string; host?: string };
      if (typeof o.path === 'string') key = o.path;
      else {
        key = Number(o.port);
        host = o.host ?? host;
      }
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) key = first;
    else {
      key = Number(first);
      if (typeof args[1] === 'string') host = args[1];
    }
    if (cb) this.once('connect', cb);
    this.connecting = true;
    this.key = key;
    if (typeof key === 'number') this.remotePort = key;
    const local = typeof key === 'string' || LOCAL_HOSTS.has(host);
    const server = local ? netServers.get(key) : undefined;
    if (server) {
      const serverSide = new Socket();
      link(this, serverSide);
      timers.setTimeout(() => {
        server.accept(serverSide);
        this.established();
      }, 0);
    } else if (!local || !netLinks.connect?.(key, this)) {
      timers.setTimeout(() => this.refuse(`connect ECONNREFUSED ${typeof key === 'string' ? key : `${host}:${key}`}`), 0);
    }
    return this;
  }
  /** The connection is open (called by whoever routed it). */
  established() {
    this.connecting = false;
    this.pending = false;
    this.emit('connect');
    this.emit('ready');
  }
  refuse(message: string) {
    this.connecting = false;
    this.destroy(Object.assign(new Error(message), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: this.key }));
  }
  /** Data from the peer. */
  receive(chunk: Uint8Array | null) {
    if (chunk === null) this.push(null);
    else {
      this.bytesRead += chunk.length;
      this.push(Buffer.from(chunk));
    }
  }
  _read() {}
  _write(chunk: unknown, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, enc) : (chunk as Uint8Array);
    this.bytesWritten += bytes.length;
    if (!this.peer) return cb(Object.assign(new Error('This socket is not connected'), { code: 'ENOTCONN' }));
    this.peer.data(new Uint8Array(bytes));
    cb();
  }
  _final(cb: () => void) {
    this.peer?.end();
    cb();
  }
  _destroy(err: Error | null, cb: (e: Error | null) => void) {
    const peer = this.peer;
    this.peer = null;
    peer?.close();
    cb(err);
  }
  setTimeout(ms?: number, cb?: () => void) {
    if (cb) this.once('timeout', cb);
    return this;
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setEncoding(enc?: BufferEncoding) {
    super.setEncoding(enc as BufferEncoding);
    return this;
  }
  ref() { return this; }
  unref() { return this; }
  address() {
    return { address: this.localAddress, family: 'IPv4', port: this.localPort };
  }
  get readyState() {
    return this.connecting ? 'opening' : this.destroyed ? 'closed' : 'open';
  }
}

/** Connects two sockets in this runtime. */
function link(a: Socket, b: Socket) {
  const to = (s: Socket): Peer => ({
    data: (chunk) => queueMicrotask(() => s.receive(chunk)),
    end: () => queueMicrotask(() => s.receive(null)),
    close: () => queueMicrotask(() => s.destroy()),
  });
  a.peer = to(b);
  b.peer = to(a);
}

/** Listening net servers by port or socket path. */
export const netServers = new Map<number | string, NetServer>();

export class NetServer extends EventEmitter {
  listening = false;
  private key: number | string = 0;
  private connections = new Set<Socket>();
  constructor(opts?: unknown, listener?: (s: Socket) => void) {
    super();
    const l = typeof opts === 'function' ? opts : listener;
    if (l) this.on('connection', l as never);
  }
  listen(...args: unknown[]) {
    const cb = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : undefined;
    const first = args[0];
    const path = typeof first === 'string' && !/^\d+$/.test(first) ? first : typeof first === 'object' && first && typeof (first as { path?: unknown }).path === 'string' ? (first as { path: string }).path : null;
    let key: number | string;
    if (path !== null) key = path;
    else {
      key = typeof first === 'object' && first ? Number((first as { port?: number }).port ?? 0) : Number(first ?? 0);
      if (!key) do key = 40000 + Math.floor(Math.random() * 20000); while (httpServers.has(key) || netServers.has(key));
    }
    if (httpServers.has(key) || netServers.has(key)) {
      timers.setTimeout(() => this.emit('error', Object.assign(new Error(`listen EADDRINUSE: address already in use ${typeof key === 'string' ? key : `:::${key}`}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', port: key })), 0);
      return this;
    }
    this.key = key;
    netServers.set(key, this);
    this.listening = true;
    netEvents.emit('listening', key);
    if (cb) this.once('listening', cb);
    timers.setTimeout(() => this.emit('listening'), 0);
    return this;
  }
  /** A new connection (its other end is connecting). */
  accept(socket: Socket) {
    if (!this.listening) return socket.destroy();
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));
    this.emit('connection', socket);
  }
  close(cb?: (e?: Error) => void) {
    if (this.listening && netServers.get(this.key) === this) netServers.delete(this.key);
    this.listening = false;
    timers.setTimeout(() => {
      this.emit('close');
      cb?.();
    }, 0);
    return this;
  }
  address() {
    if (!this.listening) return null;
    return typeof this.key === 'string' ? this.key : { address: '127.0.0.1', family: 'IPv4', port: this.key };
  }
  getConnections(cb: (e: null, n: number) => void) {
    cb(null, this.connections.size);
  }
  ref() { return this; }
  unref() { return this; }
}
export const netEvents = new EventEmitter();

const createConnection = (...args: unknown[]) => new Socket().connect(...args);

export const net = {
  isIP: (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
  isIPv4,
  isIPv6,
  Socket,
  Stream: Socket,
  Server: NetServer,
  createServer: (opts?: unknown, listener?: (s: Socket) => void) => new NetServer(opts, listener),
  connect: createConnection,
  createConnection,
  BlockList: class { addAddress() {} check() { return false; } },
  SocketAddress: class {},
  getDefaultAutoSelectFamily: () => true,
  setDefaultAutoSelectFamily: () => {},
};
