/**
 * Smaller built-ins. Where the browser cannot do the real thing (processes,
 * raw sockets, threads), the module loads fine and operations fail the way
 * Node fails when a resource is unavailable (ENOSYS / ECONNREFUSED errors),
 * so libraries that merely import them, or probe and fall back, keep working.
 */
import { EventEmitter } from 'events';
import { Readable, Writable } from 'readable-stream';
import { StringDecoder } from 'string_decoder';
import { SIGNALS, timers } from './process.ts';
import { net, NetServer, Socket } from './net.ts';

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
  constants: { signals: { ...SIGNALS }, errno: {}, priority: {} },
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

// net: see net.ts.

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
/** Node's record types (dns.resolve's rrtype), each with its function's name: resolveMx for 'MX'. */
const RRTYPES = ['A', 'AAAA', 'ANY', 'CAA', 'CNAME', 'MX', 'NAPTR', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'];
const rrName = (rrtype: string) => (rrtype === 'A' ? '4' : rrtype === 'AAAA' ? '6' : rrtype[0] + rrtype.slice(1).toLowerCase());
/**
 * A host's records. There is no resolver here: addresses are what lookup gives (an address itself,
 * the loopback for localhost, else a placeholder; no IPv6 address but those), and a host has no
 * other record: ENODATA, as from a server that has none of the type.
 */
function resolveRecords(host: string, rrtype: string, ttl: boolean): unknown[] {
  if (!RRTYPES.includes(rrtype)) throw Object.assign(new TypeError(`The argument 'rrtype' is invalid. Received ${typeof rrtype === 'string' ? `'${rrtype}'` : String(rrtype)}`), { code: 'ERR_INVALID_ARG_VALUE' });
  const family = net.isIP(host);
  const address = rrtype === 'A' ? (family === 4 ? host : family ? null : host === 'localhost' ? '127.0.0.1' : '0.0.0.0') : rrtype === 'AAAA' ? (family === 6 ? host : host === 'localhost' ? '::1' : null) : null;
  if (address) return [ttl ? { address, ttl: 0 } : address];
  const syscall = `query${rrtype === 'A' || rrtype === 'AAAA' ? rrtype[0] + rrtype.slice(1).toLowerCase() : rrName(rrtype)}`;
  throw Object.assign(new Error(`${syscall} ENODATA ${host}`), { errno: undefined, code: 'ENODATA', syscall, hostname: host });
}
type ResolveCallback = (e: unknown, records?: unknown[]) => void;
/** dns.resolve(host[, rrtype], cb): an invalid rrtype throws, a host without records calls back with the error. */
const resolve = (host: string, rrtype: string | ResolveCallback, cb?: ResolveCallback, ttl = false) => {
  const done = (typeof rrtype === 'function' ? rrtype : cb) as ResolveCallback;
  let records: unknown[] | undefined;
  let error: unknown = null;
  try {
    records = resolveRecords(host, typeof rrtype === 'string' ? rrtype : 'A', ttl);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENODATA') throw e;
    error = e;
  }
  timers.setTimeout(() => (error ? done(error) : done(null, records)), 0);
};
const resolvePromise = (host: string, rrtype = 'A', ttl = false) => new Promise((res, rej) => resolve(host, rrtype, (e, records) => (e ? rej(e) : res(records)), ttl));
/** resolve4, resolve6 (with { ttl: true }, records with their ttl), resolveMx and the others. */
const resolvers = Object.fromEntries(RRTYPES.map((rrtype) => [`resolve${rrName(rrtype)}`, (host: string, o: { ttl?: boolean } | ResolveCallback, cb?: ResolveCallback) => resolve(host, rrtype, typeof o === 'function' ? o : cb, typeof o === 'object' && !!o?.ttl)]));
const resolverPromises = Object.fromEntries(RRTYPES.map((rrtype) => [`resolve${rrName(rrtype)}`, (host: string, o?: { ttl?: boolean }) => resolvePromise(host, rrtype, !!o?.ttl)]));
export const dns = {
  lookup,
  resolve: (host: string, rrtype: string | ResolveCallback, cb?: ResolveCallback) => resolve(host, rrtype, cb),
  ...resolvers,
  setDefaultResultOrder: () => {},
  getDefaultResultOrder: () => 'ipv4first',
  promises: {
    lookup: (host: string, opts?: unknown) => new Promise((res, rej) => lookup(host, opts ?? {}, (e, address, family) => (e ? rej(e) : res(Array.isArray(address) ? address : { address, family })))),
    resolve: (host: string, rrtype?: string) => resolvePromise(host, rrtype),
    ...resolverPromises,
    setDefaultResultOrder: () => {},
  },
};

// --- processes and threads ---------------------------------------------------------------

// child_process: see ../child-process.ts; worker_threads: ../threads.ts.
export const cluster = { isPrimary: true, isMaster: true, isWorker: false, workers: {}, fork: () => { throw notSupported('cluster.fork'); }, on() {}, setupPrimary() {} };

// --- vm -------------------------------------------------------------------------------------

const contexts = new WeakSet<object>();
/**
 * Runs code with the context object as its global (a `with` scope over a proxy):
 * reads fall back to the real globals, and `globalThis`/`global`/`self` are the
 * context itself, so `globalThis.x = …` lands on the context object as in Node.
 */
function runInContext(code: string, ctx: Record<string, unknown>): unknown {
  const scope: Record<string, unknown> = new Proxy(ctx, {
    has: (t, k) => k !== 'eval' && k !== '__scope',
    get: (t, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (k === 'globalThis' || k === 'global' || k === 'self') return scope;
      return k in t ? t[k as string] : (globalThis as Record<string | symbol, unknown>)[k];
    },
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
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

// --- readline -------------------------------------------------------------------------------

type LineInput = EventEmitter & { pause?(): unknown; resume?(): unknown };
type LineOutput = { write(text: string): unknown };
type InterfaceOptions = { input?: LineInput; output?: LineOutput; prompt?: string; crlfDelay?: number };
const useAfterClose = () => Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
/**
 * readline.Interface for an input that is not a terminal: the input's lines ('line' for each, and for
 * a last one without an ending as the input ends), then 'close'; closed, it reads no more. No line editing, history or keys.
 */
class Interface extends EventEmitter {
  terminal = false;
  line = '';
  cursor = 0;
  closed = false;
  input?: LineInput;
  output?: LineOutput;
  private promptText: string;
  // One decoder for the input: a character's bytes may come in two chunks.
  private decoder = new StringDecoder('utf8');
  /** The text since the last line ending. */
  private rest = '';
  /** The last chunk ended with a '\r': a '\n' that starts the next belongs to it (as with crlfDelay: Infinity). */
  private afterReturn = false;
  /** The question that waits for its answer, and the prompt to go back to after it. */
  private asked: { done: (answer: string) => void; prompt: string } | null = null;
  private iterator?: AsyncIterableIterator<string>;
  private onData = (chunk: Uint8Array | string) => this.feed(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  private onEnd = () => {
    const last = this.rest + this.decoder.end();
    this.rest = '';
    // As Node's: a 'line', not a waiting question's answer.
    if (last) this.emit('line', last);
    this.close();
  };
  private onError = (e: unknown) => this.emit('error', e);
  /** createInterface(options) or (input, output). */
  constructor(input?: LineInput | InterfaceOptions, output?: LineOutput) {
    super();
    const options: InterfaceOptions = input && typeof (input as LineInput).on === 'function' ? { input: input as LineInput, output } : ((input ?? {}) as InterfaceOptions);
    this.input = options.input;
    this.output = options.output;
    this.promptText = options.prompt ?? '> ';
    this.input?.on('data', this.onData);
    this.input?.on('end', this.onEnd);
    this.input?.on('error', this.onError);
    this.input?.resume?.();
  }
  private feed(text: string) {
    if (this.afterReturn && text[0] === '\n') text = text.slice(1);
    if (text) this.afterReturn = text.endsWith('\r');
    const lines = (this.rest + text).split(/\r\n|\n|\r/);
    this.rest = lines.pop()!;
    // (As Node's: a chunk's lines are all emitted, one of them closing it or not.)
    for (const line of lines) this.gotLine(line);
  }
  /** A line: the answer to the question, if one waits, else a 'line' event. */
  private gotLine(line: string) {
    const asked = this.asked;
    if (!asked) return void this.emit('line', line);
    this.asked = null;
    this.promptText = asked.prompt;
    asked.done(line);
  }
  /**
   * Writes the query to the output (as the prompt, until answered); the next line is its answer (not
   * a 'line' event). As Node's, one asked while another waits only shows the prompt again.
   */
  question(query: string, options: unknown, cb?: (answer: string) => void): unknown {
    const done = (typeof options === 'function' ? options : cb) as (answer: string) => void;
    if (this.closed) throw useAfterClose();
    if (!this.asked) {
      this.asked = { done, prompt: this.promptText };
      this.promptText = query;
    }
    this.prompt();
    return undefined;
  }
  close() {
    if (this.closed) return;
    this.pause();
    this.closed = true;
    this.input?.removeListener('data', this.onData);
    this.input?.removeListener('end', this.onEnd);
    this.input?.removeListener('error', this.onError);
    this.emit('close');
  }
  pause() {
    this.input?.pause?.();
    this.emit('pause');
    return this;
  }
  resume() {
    this.input?.resume?.();
    this.emit('resume');
    return this;
  }
  setPrompt(prompt: string) { this.promptText = prompt; }
  getPrompt() { return this.promptText; }
  prompt() {
    if (this.closed) throw useAfterClose();
    this.input?.resume?.();
    this.output?.write(this.promptText);
  }
  /** Without a terminal, what is written is read as input. */
  write(data?: string | Uint8Array | null) {
    if (this.closed) throw useAfterClose();
    if (data != null) this.feed(typeof data === 'string' ? data : new TextDecoder().decode(data));
  }
  getCursorPos() { return { rows: 0, cols: 0 }; }
  /**
   * The lines from now on, until 'close' (one iterator, as Node's: lines emitted before it is asked
   * for are not in it). The input is paused while many lines wait to be taken.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    if (this.iterator) return this.iterator;
    const lines: string[] = [];
    const takers: ((r: IteratorResult<string>) => void)[] = [];
    let ended = this.closed;
    let paused = false;
    const onLine = (line: string) => {
      const taker = takers.shift();
      if (taker) return taker({ value: line, done: false });
      lines.push(line);
      if (lines.length >= 1024 && !paused && !this.closed) {
        paused = true;
        this.pause();
      }
    };
    const onClose = () => {
      ended = true;
      for (const taker of takers.splice(0)) taker({ value: undefined, done: true });
    };
    const stop = () => {
      ended = true;
      lines.length = 0;
      this.removeListener('line', onLine);
      this.removeListener('close', onClose);
      onClose();
    };
    this.on('line', onLine);
    this.on('close', onClose);
    return (this.iterator = {
      next: () => {
        if (lines.length) {
          const value = lines.shift()!;
          if (paused && !lines.length && !this.closed) {
            paused = false;
            this.resume();
          }
          return Promise.resolve({ value, done: false });
        }
        if (ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => takers.push(resolve));
      },
      return: () => {
        stop();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });
  }
  [Symbol.dispose]() {
    this.close();
  }
}
/** readline/promises' Interface: question() returns a promise of the answer. */
class PromisesInterface extends Interface {
  question(query: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        super.question(query, resolve);
      } catch (e) {
        reject(e);
      }
    });
  }
}

export const readline = {
  Interface,
  createInterface: (input?: LineInput | InterfaceOptions, output?: LineOutput) => new Interface(input, output),
  clearLine: (_s: unknown, _d: unknown, cb?: () => void) => { cb?.(); return true; },
  cursorTo: (_s: unknown, _x: unknown, _y?: unknown, cb?: () => void) => { if (typeof _y === 'function') _y(); else cb?.(); return true; },
  moveCursor: () => true,
  clearScreenDown: () => true,
  emitKeypressEvents: () => {},
  promises: {
    Interface: PromisesInterface,
    createInterface: (input?: LineInput | InterfaceOptions, output?: LineOutput) => new PromisesInterface(input, output),
  },
};

// --- .env files ------------------------------------------------------------------------------

/**
 * A .env file's variables, as Node's parser reads them (util.parseEnv, process.loadEnvFile), its
 * oddities too (checked against Node's on random input): `KEY=value` lines, the key and an unquoted
 * value trimmed; an `export ` before the key; `#` comments, on a line of their own or after an
 * unquoted value; values in single, double or back quotes without them, over several lines if so
 * written, `\n` a newline in double quotes; a quote that is not closed is part of its line's value.
 * In the keys' sorted order (Node keeps them in a std::map).
 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  const trim = (s: string) => s.replace(/^[ \t\n\f\v]+|[ \t\n\f\v]+$/g, '');
  const trimStart = (s: string) => s.replace(/^[ \t\n\f\v]+/, '');
  let rest = trim(text.replace(/\r/g, ''));
  /** The text after the line `from` is in. */
  const afterLine = (from = 0) => {
    const newline = rest.indexOf('\n', from);
    return newline < 0 ? '' : rest.slice(newline + 1);
  };
  while (rest) {
    if (rest[0] === '\n' || rest[0] === '#') {
      rest = afterLine();
      continue;
    }
    const equal = rest.search(/[=\n]/);
    // A line without '='.
    if (equal < 0 || rest[equal] === '\n') {
      rest = trimStart(afterLine());
      continue;
    }
    let key = trim(rest.slice(0, equal));
    rest = rest.slice(equal + 1);
    if (!rest || rest[0] === '\n') {
      env[key] = '';
      rest = rest.slice(1);
      continue;
    }
    rest = trimStart(rest);
    if (!key) continue;
    if (key.startsWith('export ')) key = trim(key.slice(7));
    if (!rest) {
      env[key] = '';
      break;
    }
    const quote = rest[0];
    const quoted = quote === '"' || quote === "'" || quote === '`';
    const close = quoted ? rest.indexOf(quote, 1) : -1;
    if (close >= 0) {
      const value = rest.slice(1, close);
      env[key] = quote === '"' ? value.replaceAll('\\n', '\n') : value;
      rest = afterLine(close + 1);
      continue;
    }
    const newline = rest.indexOf('\n');
    let value = newline < 0 ? rest : rest.slice(0, newline);
    if (!quoted) {
      const hash = value.indexOf('#');
      value = trim(hash < 0 ? value : value.slice(0, hash));
    }
    env[key] = value;
    rest = trimStart(afterLine());
  }
  return Object.fromEntries(Object.keys(env).sort().map((k) => [k, env[k]]));
}

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
