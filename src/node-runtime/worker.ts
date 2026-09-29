/**
 * Sandburg's Node.js runtime for the browser: runs in a dedicated Web Worker
 * (ADR 0006). The host page sends the project and an install key; the worker
 * serves node_modules lazily from the host, runs the entry script with a
 * Node-compatible module system and built-ins, and bridges HTTP requests for
 * virtual servers.
 */
import { Buffer } from 'buffer';
import events, { EventEmitter } from 'events';
import * as rs from 'readable-stream';
import util from 'util';
import assert from 'assert';
import pathBrowserify from 'path-browserify';
import * as legacyUrl from 'url';
import querystring from 'querystring-es3';
import * as stringDecoder from 'string_decoder';
import cryptoBrowserify from 'crypto-browserify';
import zlibBrowserify from 'browserify-zlib';
import { asyncHooks, installAsyncContext } from './async-context.ts';
import { createFs } from './builtins/fs.ts';
import { http, https, servers, serverEvents } from './builtins/http.ts';
import { ExitError, NODE_VERSION, createProcess, timers, timersPromises } from './builtins/process.ts';
import * as misc from './builtins/misc.ts';
import { createModuleSystem } from './loader.ts';
import { Vfs } from './vfs.ts';
import type { FileTree } from '../types.ts';

export type ToWorker =
  | { type: 'init'; cwd: string; env: Record<string, string>; files: FileTree; installKey: string | null; nodeModules: Record<string, number> | null; base: string }
  | { type: 'run'; main: string; argv?: string[] }
  | { type: 'request'; id: number; port: number; method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null };

export type FromWorker =
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'listening'; port: number }
  | { type: 'response-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'response-chunk'; id: number; chunk: Uint8Array }
  | { type: 'response-end'; id: number }
  | { type: 'response-error'; id: number; message: string }
  | { type: 'exit'; code: number }
  | { type: 'fatal'; message: string; stack?: string }
  | { type: 'ready' };

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

installAsyncContext();

let base = '/__sandburg';
let installKey: string | null = null;
let projectRoot = '/app';

function syncGet(url: string, binary: boolean): { status: number; body: Uint8Array | string } {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  if (binary) xhr.responseType = 'arraybuffer';
  xhr.send();
  return { status: xhr.status, body: binary ? new Uint8Array(xhr.response as ArrayBuffer) : xhr.responseText };
}

const vfs = new Vfs((path) => {
  const rel = path.slice(projectRoot.length + 1);
  const res = syncGet(`${base}/nm/${installKey}/f/${rel}`, true);
  if (res.status !== 200) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  return res.body as Uint8Array;
});

let proc: ReturnType<typeof createProcess>;

function write(stream: 'stdout' | 'stderr', text: string) {
  post({ type: 'log', stream, text });
}

function buildBuiltins() {
  const fs = createFs(vfs, () => (proc.cwd as () => string)());
  const path = Object.assign(Object.create(null), pathBrowserify, {
    toNamespacedPath: (p: string) => p,
    matchesGlob: () => false,
  });
  path.posix = path;
  path.win32 = path;
  path.default = path;

  // Like Node, the module itself is the legacy Stream class (an EventEmitter with pipe());
  // libraries such as `send` inherit from it.
  const LegacyStream = rs.Stream as unknown as { new (opts?: object): object; prototype: object; call(self: unknown, opts?: object): void };
  function Stream(this: unknown, opts?: object) {
    LegacyStream.call(this, opts);
  }
  Stream.prototype = LegacyStream.prototype;
  const stream = Object.assign(Stream as unknown as Record<string, unknown>, rs, {
    Stream,
    promises: rs.promises ?? { pipeline: util.promisify(rs.pipeline), finished: util.promisify(rs.finished) },
    isReadable: (s: { readable?: boolean }) => !!s?.readable,
    isErrored: (s: { errored?: unknown }) => !!s?.errored,
    getDefaultHighWaterMark: () => 65536,
    setDefaultHighWaterMark: () => {},
  });
  // Node >= 17: Readable.fromWeb / toWeb and friends.
  const Readable = rs.Readable as unknown as Record<string, unknown>;
  Readable.fromWeb ??= (web: ReadableStream, opts?: object) => {
    const reader = web.getReader();
    return new rs.Readable({
      ...opts,
      read() {
        reader.read().then(({ done, value }) => this.push(done ? null : Buffer.from(value)), (e) => this.destroy(e));
      },
      destroy(err, cb) {
        reader.cancel(err).finally(() => cb(err));
      },
    });
  };
  Readable.toWeb ??= (node: NodeJS.ReadableStream) =>
    new ReadableStream({
      start(controller) {
        node.on('data', (c: Buffer | string) => controller.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c)));
        node.on('end', () => controller.close());
        node.on('error', (e: Error) => controller.error(e));
      },
      cancel() {
        (node as unknown as { destroy(): void }).destroy?.();
      },
    });
  const Writable = rs.Writable as unknown as Record<string, unknown>;
  Writable.fromWeb ??= (web: WritableStream) => {
    const writer = web.getWriter();
    return new rs.Writable({
      write(chunk, _e, cb) {
        writer.write(chunk).then(() => cb(), cb);
      },
      final(cb) {
        writer.close().then(() => cb(), cb);
      },
    });
  };
  Writable.toWeb ??= (node: NodeJS.WritableStream) =>
    new WritableStream({
      write: (chunk) => new Promise<void>((res) => (node.write(chunk) ? res() : node.once('drain', () => res()))),
      close: () => new Promise<void>((res) => node.end(res)),
    });

  const nodeUtil = Object.assign(Object.create(null), util, {
    types: { ...(util as unknown as { types?: object }).types, isPromise: (v: unknown) => v instanceof Promise, isUint8Array: (v: unknown) => v instanceof Uint8Array, isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer, isArrayBufferView: ArrayBuffer.isView, isNativeError: (v: unknown) => v instanceof Error, isProxy: () => false, isExternal: () => false, isBoxedPrimitive: () => false, isModuleNamespaceObject: () => false },
    TextEncoder,
    TextDecoder,
    stripVTControlCharacters: (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''),
    styleText: (_style: unknown, text: string) => text,
    isDeepStrictEqual: (a: unknown, b: unknown) => {
      try {
        assert.deepStrictEqual(a, b);
        return true;
      } catch {
        return false;
      }
    },
    toUSVString: (s: string) => (s as unknown as { toWellFormed?(): string }).toWellFormed?.() ?? s,
    getSystemErrorName: (n: number) => `E${-n}`,
    getSystemErrorMap: () => new Map(),
    aborted: (signal: AbortSignal) => new Promise((r) => signal.addEventListener('abort', r, { once: true })),
    transferableAbortSignal: (s: AbortSignal) => s,
    parseEnv: (s: string) => Object.fromEntries(s.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])),
    getCallSites: () => [],
  });
  nodeUtil.inspect.custom ??= Symbol.for('nodejs.util.inspect.custom');

  const url = {
    ...legacyUrl,
    URL,
    URLSearchParams,
    fileURLToPath: (u: string | URL) => {
      const s = String(u);
      if (!s.startsWith('file:')) throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
      return decodeURIComponent(new URL(s).pathname);
    },
    pathToFileURL: (p: string) => new URL(`file://${encodeURI(p.startsWith('/') ? p : `${(proc.cwd as () => string)()}/${p}`).replace(/[?#]/g, encodeURIComponent)}`),
    domainToASCII: (d: string) => new URL(`http://${d}`).hostname,
    domainToUnicode: (d: string) => d,
    urlToHttpOptions: (u: URL) => ({ protocol: u.protocol, hostname: u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port ? Number(u.port) : undefined }),
  };

  const crypto = Object.assign(Object.create(null), cryptoBrowserify, {
    webcrypto: globalThis.crypto,
    subtle: globalThis.crypto.subtle,
    getRandomValues: <T extends ArrayBufferView>(a: T) => globalThis.crypto.getRandomValues(a as never) as T,
    randomUUID: () => globalThis.crypto.randomUUID(),
    randomInt: (min: number, max?: number) => {
      if (max === undefined) [min, max] = [0, min];
      return min + Math.floor(Math.random() * (max - min));
    },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]),
    getHashes: () => ['md5', 'sha1', 'sha256', 'sha384', 'sha512'],
    getCiphers: () => [],
    constants: {},
    hash: (alg: string, data: string, enc: BufferEncoding = 'hex') => cryptoBrowserify.createHash(alg).update(data).digest(enc),
  });

  const zlibUnsupported = (name: string) => () => {
    throw Object.assign(new Error(`zlib.${name} (brotli/zstd) is not available in the browser runtime`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  };
  const zlib = Object.assign(Object.create(null), zlibBrowserify, {
    createBrotliCompress: zlibUnsupported('createBrotliCompress'),
    createBrotliDecompress: zlibUnsupported('createBrotliDecompress'),
    brotliCompressSync: zlibUnsupported('brotliCompressSync'),
    brotliDecompressSync: zlibUnsupported('brotliDecompressSync'),
    brotliCompress: zlibUnsupported('brotliCompress'),
    brotliDecompress: zlibUnsupported('brotliDecompress'),
    crc32: (data: Uint8Array | string) => {
      let c = ~0;
      for (const b of typeof data === 'string' ? new TextEncoder().encode(data) : data) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    },
  });
  zlib.constants = { ...zlibBrowserify.constants, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_MODE: 0, BROTLI_MODE_TEXT: 1, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_PROCESS: 0 };

  const assertStrict = Object.assign((v: unknown, m?: string) => assert.strict(v, m as string), assert.strict);

  const table: Record<string, () => unknown> = {
    fs: () => fs,
    'fs/promises': () => fs.promises,
    path: () => path,
    'path/posix': () => path,
    'path/win32': () => path,
    buffer: () => ({ Buffer, SlowBuffer: Buffer, kMaxLength: 2 ** 31 - 1, kStringMaxLength: 2 ** 29, constants: { MAX_LENGTH: 2 ** 31 - 1, MAX_STRING_LENGTH: 2 ** 29 }, Blob, File, atob, btoa, isUtf8: () => true, isAscii: (b: Uint8Array) => b.every((x) => x < 128), transcode: (b: Uint8Array) => b, INSPECT_MAX_BYTES: 50 }),
    events: () => Object.assign(events, { EventEmitter, default: events, getEventListeners: (e: EventEmitter, n: string) => e.listeners(n), setMaxListeners: () => {}, addAbortListener: (s: AbortSignal, fn: () => void) => { s.addEventListener('abort', fn); return { [Symbol.dispose]: () => s.removeEventListener('abort', fn) }; } }),
    stream: () => stream,
    'stream/promises': () => stream.promises,
    'stream/web': () => ({ ReadableStream, WritableStream, TransformStream, TextEncoderStream, TextDecoderStream, ByteLengthQueuingStrategy, CountQueuingStrategy, CompressionStream, DecompressionStream }),
    'stream/consumers': () => ({
      text: async (s: AsyncIterable<Uint8Array | string>) => {
        let t = '';
        for await (const c of s) t += typeof c === 'string' ? c : new TextDecoder().decode(c);
        return t;
      },
      buffer: async (s: AsyncIterable<Uint8Array>) => {
        const parts: Uint8Array[] = [];
        for await (const c of s) parts.push(c);
        return Buffer.concat(parts);
      },
      json: async (s: AsyncIterable<Uint8Array>) => JSON.parse(new TextDecoder().decode(Buffer.concat(await (async () => { const p: Uint8Array[] = []; for await (const c of s) p.push(c); return p; })()))),
    }),
    string_decoder: () => stringDecoder,
    util: () => nodeUtil,
    'util/types': () => nodeUtil.types,
    sys: () => nodeUtil,
    assert: () => assert,
    'assert/strict': () => assertStrict,
    url: () => url,
    querystring: () => querystring,
    punycode: () => ({ toASCII: (s: string) => url.domainToASCII(s), toUnicode: (s: string) => s, encode: (s: string) => s, decode: (s: string) => s }),
    crypto: () => crypto,
    zlib: () => zlib,
    os: () => misc.os,
    tty: () => misc.tty,
    net: () => misc.net,
    tls: () => misc.tls,
    dns: () => misc.dns,
    'dns/promises': () => misc.dns.promises,
    http: () => http,
    https: () => https,
    http2: () => misc.http2,
    _http_agent: () => ({ Agent: http.Agent, globalAgent: http.globalAgent }),
    _http_common: () => ({ methods: http.METHODS }),
    child_process: () => misc.childProcess,
    worker_threads: () => misc.workerThreads,
    cluster: () => misc.cluster,
    vm: () => misc.vm,
    v8: () => misc.v8,
    perf_hooks: () => misc.perfHooks,
    diagnostics_channel: () => misc.diagnosticsChannel,
    async_hooks: () => asyncHooks,
    timers: () => ({ ...timers, promises: timersPromises }),
    'timers/promises': () => timersPromises,
    process: () => proc,
    console: () => console,
    constants: () => ({ ...misc.os.constants.signals, ...fs.constants }),
    readline: () => misc.readline,
    'readline/promises': () => misc.readline.promises,
    inspector: () => misc.inspector,
    'inspector/promises': () => misc.inspector,
    repl: () => misc.stub('repl'),
    dgram: () => misc.stub('dgram'),
    domain: () => ({ create: () => Object.assign(new EventEmitter(), { run: (fn: () => unknown) => fn(), add() {}, remove() {}, bind: (fn: unknown) => fn, intercept: (fn: unknown) => fn, enter() {}, exit() {}, dispose() {} }) }),
    trace_events: () => ({ createTracing: () => ({ enable() {}, disable() {}, enabled: false }), getEnabledCategories: () => '' }),
    wasi: () => misc.stub('wasi'),
    test: () => misc.stub('test'),
    sqlite: () => misc.stub('sqlite'),
    sea: () => ({ isSea: () => false }),
  };
  return table;
}

let moduleSystem: ReturnType<typeof createModuleSystem>;

function init(msg: Extract<ToWorker, { type: 'init' }>) {
  base = msg.base;
  installKey = msg.installKey;
  projectRoot = msg.cwd;
  for (const [path, content] of Object.entries(msg.files)) {
    const abs = `${msg.cwd}/${path}`;
    vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
    vfs.write(abs, typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0)));
  }
  for (const [rel, size] of Object.entries(msg.nodeModules ?? {})) vfs.addRemote(`${msg.cwd}/${rel}`, size);
  vfs.mkdir('/tmp', true);

  proc = createProcess({ cwd: msg.cwd, env: { NODE_ENV: 'development', HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', ...msg.env }, argv: ['/usr/local/bin/node'], write });
  const table = buildBuiltins();
  const cache = new Map<string, unknown>();
  const builtin = (name: string) => {
    if (name === 'module') return moduleSystem.Module;
    if (!cache.has(name)) {
      const make = table[name];
      if (!make) throw Object.assign(new Error(`No such built-in module: node:${name}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
      cache.set(name, make());
    }
    return cache.get(name);
  };
  const compiledCache = new Map<string, string>();
  moduleSystem = createModuleSystem({
    vfs,
    compiledNodeModule(path: string) {
      if (!installKey) return null;
      const rel = path.slice(projectRoot.length + 1);
      const res = syncGet(`${base}/nm/${installKey}/t/${rel}`, false);
      return res.status === 200 ? (res.body as string) : null;
    },
    compile(code: string, path: string, kind: 'esm' | 'cjs' | 'ts') {
      const key = `${kind}:${path}:${code.length}:${hash(code)}`;
      const hit = compiledCache.get(key);
      if (hit !== undefined) return hit;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/compile?kind=${kind}&path=${encodeURIComponent(path)}`, false);
      xhr.send(code);
      if (xhr.status !== 200) throw Object.assign(new SyntaxError(xhr.responseText), { code: 'ERR_COMPILE' });
      compiledCache.set(key, xhr.responseText);
      return xhr.responseText;
    },
    builtin,
    builtinNames: [...Object.keys(table), 'module'],
    prefixOnly: new Set(['test', 'sqlite', 'sea', 'test/reporters']),
    process: proc as unknown as { dlopen(m: unknown, f: string): void },
    cwd: () => (proc.cwd as () => string)(),
    argv1: () => (proc.argv as string[])[1],
  } as never);

  // Node's console writes to process.stdout/stderr.
  const nodeUtil = builtin('util') as { format(...a: unknown[]): string; inspect(v: unknown, o?: object): string };
  const counts = new Map<string, number>();
  const times = new Map<string, number>();
  let indent = '';
  const emit = (stream: 'stdout' | 'stderr') => (...args: unknown[]) => write(stream, indent + nodeUtil.format(...args).replaceAll('\n', `\n${indent}`) + '\n');
  const nodeConsole = {
    log: emit('stdout'), info: emit('stdout'), debug: emit('stdout'),
    warn: emit('stderr'), error: emit('stderr'),
    trace: (...a: unknown[]) => emit('stderr')(`Trace: ${nodeUtil.format(...a)}\n${new Error().stack?.split('\n').slice(2).join('\n')}`),
    dir: (v: unknown, o?: object) => write('stdout', nodeUtil.inspect(v, o) + '\n'),
    dirxml: emit('stdout'),
    table: (v: unknown) => emit('stdout')(v),
    assert: (ok: unknown, ...a: unknown[]) => { if (!ok) emit('stderr')('Assertion failed' + (a.length ? `: ${nodeUtil.format(...a)}` : '')); },
    count: (l = 'default') => { counts.set(l, (counts.get(l) ?? 0) + 1); emit('stdout')(`${l}: ${counts.get(l)}`); },
    countReset: (l = 'default') => counts.delete(l),
    time: (l = 'default') => times.set(l, performance.now()),
    timeEnd: (l = 'default') => { emit('stdout')(`${l}: ${(performance.now() - (times.get(l) ?? 0)).toFixed(3)}ms`); times.delete(l); },
    timeLog: (l = 'default', ...a: unknown[]) => emit('stdout')(`${l}: ${(performance.now() - (times.get(l) ?? 0)).toFixed(3)}ms`, ...a),
    group: (...a: unknown[]) => { if (a.length) emit('stdout')(...a); indent += '  '; },
    groupCollapsed: (...a: unknown[]) => { if (a.length) emit('stdout')(...a); indent += '  '; },
    groupEnd: () => { indent = indent.slice(2); },
    profile() {}, profileEnd() {}, timeStamp() {},
  };
  (nodeConsole as Record<string, unknown>).Console = function Console() { return nodeConsole; };
  table.console = () => nodeConsole;

  // Node globals.
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, {
    console: nodeConsole,
    process: proc,
    Buffer,
    global: globalThis,
    setTimeout: timers.setTimeout,
    setInterval: timers.setInterval,
    clearTimeout: timers.clearTimeout,
    clearInterval: timers.clearInterval,
    setImmediate: timers.setImmediate,
    clearImmediate: timers.clearImmediate,
  });

  // Uncaught errors and rejections go through process events, as in Node.
  self.addEventListener('error', (e) => {
    if (e.error instanceof ExitError) return e.preventDefault();
    if ((proc.env as Record<string, string>).SANDBURG_DEBUG_ERRORS) write('stderr', `[sandburg] uncaught: ${e.error?.stack ?? e.message}\n`);
    if (proc.listenerCount('uncaughtException')) {
      e.preventDefault();
      proc.emit('uncaughtException', e.error, 'uncaughtException');
    }
  });
  self.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof ExitError) return e.preventDefault();
    if (proc.listenerCount('unhandledRejection')) {
      e.preventDefault();
      proc.emit('unhandledRejection', e.reason, e.promise);
    } else {
      write('stderr', `Uncaught (in promise) ${e.reason?.stack ?? e.reason}\n`);
    }
  });
  serverEvents.on('listening', (port: number) => post({ type: 'listening', port }));
  post({ type: 'ready' });
}

function run(msg: Extract<ToWorker, { type: 'run' }>) {
  proc.argv = ['/usr/local/bin/node', msg.main, ...(msg.argv ?? [])];
  try {
    (moduleSystem.Module as unknown as { _load(r: string, p: null, m: boolean): unknown })._load(msg.main, null, true);
  } catch (e) {
    if (e instanceof ExitError) return post({ type: 'exit', code: e.code });
    post({ type: 'fatal', message: String((e as Error)?.message ?? e), stack: (e as Error)?.stack });
  }
}

function request(msg: Extract<ToWorker, { type: 'request' }>) {
  const server = servers.get(msg.port);
  if (!server) return post({ type: 'response-error', id: msg.id, message: `nothing listening on port ${msg.port}` });
  try {
    server.dispatch(msg.method, msg.url, msg.headers, msg.body ? new Uint8Array(msg.body) : null, {
      start: (status, statusText, headers) => post({ type: 'response-start', id: msg.id, status, statusText, headers }),
      chunk: (data) => post({ type: 'response-chunk', id: msg.id, chunk: data }, [data.buffer]),
      end: () => post({ type: 'response-end', id: msg.id }),
    });
  } catch (e) {
    post({ type: 'response-error', id: msg.id, message: String((e as Error)?.stack ?? e) });
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'run') run(msg);
  else if (msg.type === 'request') request(msg);
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const RUNTIME_NODE_VERSION = NODE_VERSION;
