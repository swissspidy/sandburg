/**
 * Smaller built-ins. Where the browser cannot do the real thing (processes,
 * raw sockets, threads), the module loads fine and operations fail the way
 * Node fails when a resource is unavailable (ENOSYS / ECONNREFUSED errors),
 * so libraries that merely import them, or probe and fall back, keep working.
 */
import { EventEmitter } from 'events';
import { Duplex, Readable, Writable } from 'readable-stream';
import { timers } from './process.ts';

const notSupported = (what: string) => Object.assign(new Error(`${what} is not available in the browser runtime`), { code: 'ENOSYS', errno: -38 });

export const os = {
  EOL: '\n',
  devNull: '/dev/null',
  platform: () => 'linux',
  type: () => 'Linux',
  release: () => '6.8.0-sandburg',
  version: () => '#1 SMP Sandburg',
  machine: () => 'x86_64',
  arch: () => 'x64',
  endianness: () => 'LE',
  hostname: () => 'sandburg',
  homedir: () => '/root',
  tmpdir: () => '/tmp',
  uptime: () => Math.floor(performance.now() / 1000),
  loadavg: () => [0, 0, 0],
  totalmem: () => 8 * 1024 ** 3,
  freemem: () => 4 * 1024 ** 3,
  availableParallelism: () => navigator.hardwareConcurrency || 4,
  cpus: () =>
    Array.from({ length: navigator.hardwareConcurrency || 4 }, () => ({ model: 'Browser CPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
  networkInterfaces: () => ({ lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] }),
  userInfo: () => ({ username: 'root', uid: 0, gid: 0, shell: '/bin/sh', homedir: '/root' }),
  getPriority: () => 0,
  setPriority: () => {},
  constants: { signals: { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }, errno: {}, priority: {} },
};

class WriteStream extends Writable {
  isTTY = false;
  columns = 120;
  rows = 40;
  _write(_c: unknown, _e: unknown, cb: () => void) { cb(); }
  getColorDepth() { return 1; }
  hasColors() { return false; }
}
export const tty = { isatty: () => false, WriteStream, ReadStream: Readable };

// --- net / tls / dns ------------------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const isIPv4 = (s: string) => IPV4.test(s);
const isIPv6 = (s: string) => {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return false;
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
};

class Socket extends Duplex {
  remoteAddress?: string;
  connecting = false;
  constructor() {
    super();
  }
  connect(..._args: unknown[]) {
    timers.setTimeout(() => this.destroy(Object.assign(new Error('connect ECONNREFUSED (raw sockets are not available in the browser runtime)'), { code: 'ECONNREFUSED' })), 0);
    return this;
  }
  _read() {}
  _write(_c: unknown, _e: unknown, cb: () => void) { cb(); }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  address() { return {}; }
}

class NetServer extends EventEmitter {
  listen() {
    timers.setTimeout(() => this.emit('error', notSupported('net.Server.listen')), 0);
    return this;
  }
  close(cb?: () => void) { cb?.(); return this; }
  address() { return null; }
  ref() { return this; }
  unref() { return this; }
}

export const net = {
  isIP: (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
  isIPv4,
  isIPv6,
  Socket,
  Stream: Socket,
  Server: NetServer,
  createServer: () => new NetServer(),
  connect: () => new Socket().connect(),
  createConnection: () => new Socket().connect(),
  BlockList: class { addAddress() {} check() { return false; } },
  SocketAddress: class {},
  getDefaultAutoSelectFamily: () => true,
  setDefaultAutoSelectFamily: () => {},
};

export const tls = {
  ...net,
  TLSSocket: Socket,
  connect: () => new Socket().connect(),
  createServer: () => new NetServer(),
  createSecureContext: () => ({}),
  rootCertificates: [],
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
  checkServerIdentity: () => undefined,
};

const lookup = (host: string, opts: unknown, cb?: (e: unknown, addr?: unknown, family?: number) => void) => {
  const done = (typeof opts === 'function' ? opts : cb) as (e: unknown, addr?: unknown, family?: number) => void;
  const all = typeof opts === 'object' && (opts as { all?: boolean })?.all;
  const address = host === 'localhost' || net.isIP(host) ? (net.isIP(host) ? host : '127.0.0.1') : '0.0.0.0';
  timers.setTimeout(() => (all ? done(null, [{ address, family: 4 }]) : done(null, address, 4)), 0);
};
export const dns = {
  lookup,
  resolve: (_h: string, cb: (e: unknown) => void) => timers.setTimeout(() => cb(notSupported('dns.resolve')), 0),
  setDefaultResultOrder: () => {},
  getDefaultResultOrder: () => 'ipv4first',
  promises: {
    lookup: (host: string, opts?: unknown) => new Promise((res, rej) => lookup(host, opts ?? {}, (e, address, family) => (e ? rej(e) : res(Array.isArray(address) ? address : { address, family })))),
    resolve: () => Promise.reject(notSupported('dns.resolve')),
    setDefaultResultOrder: () => {},
  },
};

// --- processes and threads ---------------------------------------------------------------

class ChildProcess extends EventEmitter {
  pid = undefined;
  stdin = new Writable({ write: (_c, _e, cb) => cb() });
  stdout = new Readable({ read() { this.push(null); } });
  stderr = new Readable({ read() { this.push(null); } });
  exitCode: number | null = null;
  killed = false;
  constructor(command: string) {
    super();
    timers.setTimeout(() => {
      this.emit('error', Object.assign(notSupported(`spawning "${command}"`), { path: command, spawnargs: [] }));
      this.exitCode = -38;
      this.emit('close', -38, null);
    }, 0);
  }
  kill() { this.killed = true; return true; }
  ref() {}
  unref() {}
  disconnect() {}
  send() { return false; }
}
const cbError = (command: string, cb?: unknown) => {
  const child = new ChildProcess(command);
  if (typeof cb === 'function') child.on('error', (e) => (cb as (e: unknown, o: string, er: string) => void)(e, '', ''));
  else child.on('error', () => {});
  return child;
};
export const childProcess = {
  ChildProcess,
  spawn: (cmd: string) => new ChildProcess(cmd),
  fork: (mod: string) => new ChildProcess(mod),
  exec: (cmd: string, opts?: unknown, cb?: unknown) => cbError(cmd, typeof opts === 'function' ? opts : cb),
  execFile: (cmd: string, args?: unknown, opts?: unknown, cb?: unknown) => cbError(cmd, [args, opts, cb].find((x) => typeof x === 'function')),
  spawnSync: (cmd: string) => ({ pid: 0, status: null, signal: null, output: [], stdout: '', stderr: '', error: notSupported(`spawning "${cmd}"`) }),
  execSync: (cmd: string) => {
    throw notSupported(`running "${cmd}"`);
  },
  execFileSync: (cmd: string) => {
    throw notSupported(`running "${cmd}"`);
  },
};

export const workerThreads = {
  isMainThread: true,
  isInternalThread: false,
  parentPort: null,
  workerData: null,
  threadId: 0,
  resourceLimits: {},
  SHARE_ENV: Symbol('SHARE_ENV'),
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  Worker: class {
    constructor(file: string) {
      throw notSupported(`worker_threads.Worker(${file})`);
    }
  },
  markAsUntransferable: () => {},
  isMarkedAsUntransferable: () => false,
  moveMessagePortToContext: (p: unknown) => p,
  receiveMessageOnPort: () => undefined,
  getEnvironmentData: () => undefined,
  setEnvironmentData: () => {},
};

export const cluster = { isPrimary: true, isMaster: true, isWorker: false, workers: {}, fork: () => { throw notSupported('cluster.fork'); }, on() {}, setupPrimary() {} };

// --- vm -------------------------------------------------------------------------------------

const contexts = new WeakSet<object>();
/** Runs code with the context object's properties as globals (a `with` scope over a proxy). */
function runInContext(code: string, ctx: Record<string, unknown>): unknown {
  const scope = new Proxy(ctx, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k as string] : (globalThis as Record<string | symbol, unknown>)[k]),
  });
  // eslint-disable-next-line no-new-func
  return new Function('__scope', `with (__scope) { return eval(${JSON.stringify(code)}); }`)(scope);
}
class Script {
  private code: string;
  constructor(code: string) {
    this.code = code;
  }
  runInThisContext() {
    return (0, eval)(this.code);
  }
  runInContext(ctx: Record<string, unknown>) {
    return runInContext(this.code, ctx);
  }
  runInNewContext(ctx: Record<string, unknown> = {}) {
    return runInContext(this.code, ctx);
  }
  createCachedData() {
    return new Uint8Array();
  }
}
export const vm = {
  Script,
  createContext: (o: Record<string, unknown> = {}) => {
    contexts.add(o);
    return o;
  },
  isContext: (o: object) => contexts.has(o),
  runInThisContext: (code: string) => (0, eval)(code),
  runInContext: (code: string, ctx: Record<string, unknown>) => runInContext(code, ctx),
  runInNewContext: (code: string, ctx: Record<string, unknown> = {}) => runInContext(code, ctx),
  // eslint-disable-next-line no-new-func
  compileFunction: (code: string, params: string[] = []) => new Function(...params, code),
  measureMemory: async () => ({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
  constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('USE_MAIN_CONTEXT_DEFAULT_LOADER'), DONT_CONTEXTIFY: Symbol('DONT_CONTEXTIFY') },
};

// --- diagnostics and introspection --------------------------------------------------------------

class Channel {
  name: string;
  private subscribers = new Set<(msg: unknown, name: string) => void>();
  constructor(name: string) {
    this.name = name;
  }
  get hasSubscribers() { return this.subscribers.size > 0; }
  subscribe(fn: (msg: unknown, name: string) => void) { this.subscribers.add(fn); }
  unsubscribe(fn: (msg: unknown, name: string) => void) { return this.subscribers.delete(fn); }
  publish(msg: unknown) { for (const fn of this.subscribers) fn(msg, this.name); }
  bindStore() {}
  unbindStore() {}
  runStores<R>(_data: unknown, fn: (...a: unknown[]) => R, thisArg?: unknown, ...args: unknown[]) { return fn.apply(thisArg, args); }
}
const channels = new Map<string, Channel>();
const channel = (name: string) => {
  let c = channels.get(name);
  if (!c) channels.set(name, (c = new Channel(name)));
  return c;
};
export const diagnosticsChannel = {
  channel,
  hasSubscribers: (name: string) => channel(name).hasSubscribers,
  subscribe: (name: string, fn: (msg: unknown, name: string) => void) => channel(name).subscribe(fn),
  unsubscribe: (name: string, fn: (msg: unknown, name: string) => void) => channel(name).unsubscribe(fn),
  tracingChannel: (name: string) => {
    const make = (suffix: string) => channel(`tracing:${name}:${suffix}`);
    return {
      start: make('start'), end: make('end'), asyncStart: make('asyncStart'), asyncEnd: make('asyncEnd'), error: make('error'),
      get hasSubscribers() { return false; },
      subscribe() {}, unsubscribe() {},
      traceSync<R>(fn: (...a: unknown[]) => R, _ctx?: unknown, thisArg?: unknown, ...args: unknown[]) { return fn.apply(thisArg, args); },
      tracePromise<R>(fn: (...a: unknown[]) => R, _ctx?: unknown, thisArg?: unknown, ...args: unknown[]) { return fn.apply(thisArg, args); },
      traceCallback<R>(fn: (...a: unknown[]) => R, _pos?: number, _ctx?: unknown, thisArg?: unknown, ...args: unknown[]) { return fn.apply(thisArg, args); },
    };
  },
  Channel,
};

export const v8 = {
  getHeapStatistics: () => ({ total_heap_size: 64e6, used_heap_size: 32e6, heap_size_limit: 4e9, total_available_size: 4e9, malloced_memory: 0, external_memory: 0 }),
  getHeapSpaceStatistics: () => [],
  getHeapSnapshot: () => new Readable({ read() { this.push(null); } }),
  writeHeapSnapshot: () => '',
  setFlagsFromString: () => {},
  serialize: (v: unknown) => new TextEncoder().encode(JSON.stringify(v)),
  deserialize: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)),
  cachedDataVersionTag: () => 0,
  isStringOneByteRepresentation: () => false,
  startupSnapshot: { isBuildingSnapshot: () => false },
};

export const perfHooks = {
  performance: globalThis.performance,
  PerformanceObserver: class { observe() {} disconnect() {} static supportedEntryTypes = [] },
  PerformanceEntry: class {},
  monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0, min: 0, max: 0, mean: 0, stddev: 0 }),
  createHistogram: () => ({ record() {}, recordDelta() {}, reset() {}, percentile: () => 0, min: 0, max: 0, mean: 0 }),
  constants: {},
};

export const readline = {
  createInterface: () => Object.assign(new EventEmitter(), { close() {}, question(_q: string, cb: (a: string) => void) { cb(''); }, on: EventEmitter.prototype.on, setPrompt() {}, prompt() {}, [Symbol.asyncIterator]: async function* () {} }),
  clearLine: (_s: unknown, _d: unknown, cb?: () => void) => { cb?.(); return true; },
  cursorTo: (_s: unknown, _x: unknown, _y?: unknown, cb?: () => void) => { if (typeof _y === 'function') _y(); else cb?.(); return true; },
  moveCursor: () => true,
  clearScreenDown: () => true,
  emitKeypressEvents: () => {},
  promises: {},
};

export const inspector = { url: () => undefined, open() {}, close() {}, Session: class { connect() {} post() {} disconnect() {} }, console };

export const http2 = {
  constants: { HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_CONTENT_TYPE: 'content-type', HTTP2_HEADER_AUTHORITY: ':authority', HTTP2_HEADER_SCHEME: ':scheme', NGHTTP2_CANCEL: 8 },
  connect: () => {
    throw notSupported('http2.connect');
  },
  createServer: () => new NetServer(),
  createSecureServer: () => new NetServer(),
  getDefaultSettings: () => ({}),
  sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
  Http2ServerRequest: class {},
  Http2ServerResponse: class {},
};

export const stub = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, k) => (k === '__esModule' ? false : k === 'default' ? undefined : typeof k === 'symbol' ? undefined : () => { throw notSupported(`${name}.${String(k)}`); }),
    },
  );
