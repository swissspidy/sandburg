/**
 * Sandburg's Node.js runtime for the browser: runs in a dedicated Web Worker
 * (ADR 0006). The host page sends the project and an install key; the worker
 * serves node_modules lazily from the host, runs the entry script with a
 * Node-compatible module system and built-ins, and bridges HTTP requests for
 * virtual servers.
 */
import { Buffer } from 'buffer';
import { loadSqlite, type FileAccess } from './builtins/sqlite/core.ts';
import { WsClientCodec } from './websocket.ts';
import { ThreadVfs, createWorkerThreads, liveRuntimes, warmRuntimes, type ThreadHost, type ThreadInit } from './threads.ts';
import { createChildProcess } from './child-process.ts';
import { installNodeFetchClasses } from './fetch-classes.ts';
import { createWasi } from './builtins/wasi.ts';
import { createBetterSqlite3 } from './builtins/sqlite/better-sqlite3.ts';
import { createSqlite3 } from './builtins/sqlite/sqlite3.ts';
import { createNodeSqlite } from './builtins/sqlite/node-sqlite.ts';
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
import { nativeZlib } from './builtins/zlib-native.ts';
import { parseArgs } from '@pkgjs/parseargs';
import { AsyncResource, asyncHooks, installAsyncContext } from './async-context.ts';
import { adoptMailboxes, installNodeMessagePorts } from './message-ports.ts';
import { createFs } from './builtins/fs.ts';
import { http, https, loopback, servers, serverEvents, type BridgeResponse, type UpgradeSocket } from './builtins/http.ts';
import { ExitError, NODE_VERSION, createProcess, pendingWork, timers, timersActive, timersPromises } from './builtins/process.ts';
import * as misc from './builtins/misc.ts';
import { net, netEvents, netLinks, netServers, Socket as NetSocket } from './builtins/net.ts';
import { createModuleSystem } from './loader.ts';
import { Vfs } from './vfs.ts';
import type { FileTree } from '../types.ts';

export type ToWorker =
  | {
      type: 'init';
      cwd: string;
      env: Record<string, string>;
      files: FileTree;
      installKey: string | null;
      /** A bundle of the install's files that runs load (see adapters/node/index.ts). */
      preload?: string | null;
      /** A bundle of project files to start with (a dev server's cache from an earlier run), same format. */
      filesBundle?: string | null;
      nodeModules: Record<string, number> | null;
      base: string;
      ipc?: boolean;
      tsRunner?: boolean;
      /** Set when this runtime is a worker thread (worker_threads.Worker) of another. */
      thread?: ThreadInit;
      /** A thread inherits these from its parent instead of scanning files it does not have. */
      inherit?: { asyncModules: boolean; usesSqlite: boolean };
    }
  /** From the parent thread to this worker thread's parentPort. */
  | { type: 'wt-message'; data: unknown; mailboxes?: Parameters<typeof adoptMailboxes>[1] }
  | { type: 'run'; main: string; argv?: string[]; preload?: string[] }
  /** The parent closed this child process's IPC channel. */
  | { type: 'disconnect' }
  /** A net connection between runtimes (see netMessage). */
  | NetMessage
  | { type: 'request'; id: number; port: number | string; method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }
  /** A message for the program (with init.ipc): process.on('message'). */
  | { type: 'message'; data: unknown }
  /** A WebSocket from the app frame to a virtual server (see websocket.ts). */
  /** Writes a project file, as an editor would (file watchers see the change). */
  | { type: 'write-file'; path: string; content: string }
  /** The text files under some directories (dev servers' caches, kept for the next run). */
  | { type: 'read-tree'; id: number; dirs: string[] }
  | { type: 'ws-open'; id: number; port: number; url: string; headers: [string, string][]; protocols: string[] }
  | { type: 'ws-send'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-close'; id: number; code?: number; reason?: string }
  /** The reply to a loopback request this runtime sent its parent (see loopback.route). */
  | { type: 'lb-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'lb-chunk'; id: number; chunk: ArrayBuffer }
  | { type: 'lb-end'; id: number }
  | { type: 'lb-error'; id: number; message: string; code?: string };

export type FromWorker =
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'listening'; port: number | string }
  | { type: 'response-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'response-chunk'; id: number; chunk: Uint8Array }
  | { type: 'response-end'; id: number }
  | { type: 'response-error'; id: number; message: string }
  | { type: 'exit'; code: number }
  | { type: 'fatal'; message: string; stack?: string }
  | { type: 'ready' }
  /** The worker's script has run; it waits for init. */
  | { type: 'booted' }
  /** process.send() from the program (with init.ipc). */
  | { type: 'message'; data: unknown }
  | { type: 'ws-accept'; id: number; protocol: string; extensions: string }
  | { type: 'ws-reject'; id: number; status: number; message: string }
  | { type: 'ws-message'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-closed'; id: number; code: number; reason: string; wasClean: boolean }
  /** A command of a shell script failed, here or in a nested runtime (passed up to the host). */
  | { type: 'process-exit'; command: string; code: number; stderr: string }
  | { type: 'tree'; id: number; files: Record<string, string | { base64: string }> };

/** An EventEmitter whose listeners run in the async context it was created in (events.EventEmitterAsyncResource). */
class EventEmitterAsyncResource extends EventEmitter {
  readonly asyncResource: AsyncResource;
  constructor(options?: { name?: string; captureRejections?: boolean }) {
    super(options);
    this.asyncResource = new AsyncResource(options?.name ?? new.target.name);
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.asyncResource.runInAsyncScope(() => super.emit(event, ...args));
  }
  emitDestroy(): void {
    this.asyncResource.emitDestroy();
  }
  get asyncId(): number {
    return this.asyncResource.asyncId();
  }
  get triggerAsyncId(): number {
    return this.asyncResource.triggerAsyncId();
  }
}

/** The buffer polyfill predates the base64url encoding (Node 15+); hashes and ids use it. */
function patchBase64Url(): void {
  const B = Buffer as unknown as {
    prototype: { toString(enc?: string, s?: number, e?: number): string; write(str: string, a?: unknown, b?: unknown, c?: unknown): number };
    from(v: unknown, enc?: unknown, len?: unknown): Buffer;
    isEncoding(e: string): boolean;
    byteLength(v: unknown, enc?: string): number;
  };
  const isUrl = (enc: unknown) => typeof enc === 'string' && enc.toLowerCase() === 'base64url';
  const toB64 = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/');
  const { toString, write } = B.prototype;
  const { from, isEncoding, byteLength } = B;
  B.prototype.toString = function (this: Buffer, enc?: string, s?: number, e?: number) {
    return isUrl(enc) ? toString.call(this, 'base64', s, e).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : toString.call(this, enc, s, e);
  };
  B.prototype.write = function (this: Buffer, str: string, a?: unknown, b?: unknown, c?: unknown) {
    if (isUrl(a)) return write.call(this, toB64(str), 'base64');
    if (isUrl(b)) return write.call(this, toB64(str), a, 'base64');
    if (isUrl(c)) return write.call(this, toB64(str), a, b, 'base64');
    return write.call(this, str, a, b, c);
  };
  B.from = function (v: unknown, enc?: unknown, len?: unknown) {
    return typeof v === 'string' && isUrl(enc) ? from.call(Buffer, toB64(v), 'base64') : from.call(Buffer, v, enc, len);
  } as typeof B.from;
  B.isEncoding = (e: string) => isUrl(e) || isEncoding(e);
  B.byteLength = (v: unknown, enc?: string) => (typeof v === 'string' && isUrl(enc) ? byteLength(toB64(v), 'base64') : byteLength(v, enc));
}
patchBase64Url();

/**
 * UTF-8 through the browser's TextEncoder/TextDecoder: the buffer polyfill converts in JavaScript
 * loops, ~13x slower than Node (11 MB: 560 ms instead of 40). Tools convert a lot (webpack's cache,
 * loaders, source maps).
 */
function patchUtf8(): void {
  const B = Buffer as unknown as {
    prototype: Record<string, (...a: unknown[]) => unknown> & { length: number; subarray(s: number, e: number): Uint8Array };
    from(v: unknown, enc?: unknown, len?: unknown): Buffer;
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const isUtf8 = (enc: unknown) => enc === undefined || enc === null || (typeof enc === 'string' && /^utf-?8$/i.test(enc));
  const { from } = B;
  const { toString, write } = B.prototype as unknown as Record<string, (this: Uint8Array, ...a: unknown[]) => unknown>;
  // Short strings stay in JavaScript: the native encoder's call costs more than it saves there.
  const SHORT = 64;
  B.from = function (v: unknown, enc?: unknown, len?: unknown) {
    if (typeof v === 'string' && v.length > SHORT && isUtf8(enc)) {
      const bytes = encoder.encode(v);
      return from.call(B, bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return from.call(B, v, enc, len);
  };
  const slice = (buf: Uint8Array, start?: unknown, end?: unknown) => {
    const s = typeof start === 'number' && start > 0 ? Math.floor(start) : 0;
    const e = typeof end === 'number' && end < buf.length ? Math.floor(end) : buf.length;
    return e <= s ? '' : decoder.decode(buf.subarray(s, e));
  };
  B.prototype.toString = function (this: Uint8Array, enc?: unknown, start?: unknown, end?: unknown) {
    return isUtf8(enc) && this.length > SHORT ? slice(this, start, end) : Reflect.apply(toString, this, [enc, start, end]);
  };
  B.prototype.utf8Slice = function (this: Uint8Array, start?: unknown, end?: unknown) {
    return slice(this, start, end);
  };
  const encodeInto = (buf: Uint8Array, str: string, offset: number, length: number) => {
    const start = Math.max(0, Math.min(offset, buf.length));
    return encoder.encodeInto(str, buf.subarray(start, Math.min(buf.length, start + length))).written;
  };
  // buf.write(string[, offset[, length]][, encoding])
  B.prototype.write = function (this: Uint8Array, str: unknown, a?: unknown, b?: unknown, c?: unknown) {
    let offset = 0;
    let length = this.length;
    let enc: unknown;
    if (typeof a === 'string') enc = a;
    else {
      if (typeof a === 'number') offset = a;
      if (typeof b === 'string') enc = b;
      else {
        if (typeof b === 'number') length = b;
        enc = c;
      }
    }
    if (typeof str !== 'string' || str.length <= SHORT || !isUtf8(enc)) return write.call(this, str, a, b, c);
    return encodeInto(this, str, offset, Math.min(length, this.length - offset));
  };
  B.prototype.utf8Write = function (this: Uint8Array, str: unknown, offset?: unknown, length?: unknown) {
    const o = typeof offset === 'number' ? offset : 0;
    return encodeInto(this, String(str), o, typeof length === 'number' ? length : this.length - o);
  };
}
patchUtf8();

// Captured before any program runs: programs may assign globalThis.postMessage/onmessage (napi-rs's thread script does).
const realPostMessage = (self as unknown as Worker).postMessage.bind(self);
const realImportScripts = (self as unknown as { importScripts(url: string): void }).importScripts.bind(self);

/**
 * Web Worker globals that Node does not have. Programs see them as plain globals that start out
 * undefined, as in Node; some set them (napi-rs' WASI thread script assigns self, importScripts and
 * postMessage for emnapi), and every module then sees the assignment.
 */
function hideWorkerGlobals(): void {
  for (const name of ['self', 'location', 'importScripts']) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true, enumerable: false });
  }
}
const post = (msg: FromWorker, transfer: Transferable[] = []) => realPostMessage(msg, transfer);

installAsyncContext();

let base = '/__sandburg';
let installKey: string | null = null;
let projectRoot = '/app';

/**
 * Installed files come from the host one synchronous request each, or from the install's preload
 * bundle: once a runtime has asked for a few files, it fetches the bundle in one request (the browser
 * caches it for the other runtimes of the run). A program's runtime switches after PRELOAD_AFTER
 * files (each single request costs ~10 ms; next dev's first 40 took 0.4 s); a worker thread after
 * PRELOAD_AFTER_THREAD, so the small WebAssembly helper threads never hold the bundle.
 */
let preloadUrl: string | null = null;
let preloaded: Map<string, Uint8Array> | null = null;
let installedRequests = 0;
const PRELOAD_AFTER = 10;
const PRELOAD_AFTER_THREAD = 40;

/** The files of a bundle (a little-endian u32 header length, a JSON header [[mode, path, length], …], the bytes). */
function readBundle(url: string): [string, Uint8Array, string][] {
  const res = requestSync(url, true);
  if (res.status !== 200) return [];
  const bytes = res.body as Uint8Array;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as [string, string, number][];
  const files: [string, Uint8Array, string][] = [];
  let at = 4 + length;
  for (const [mode, rel, size] of header) {
    files.push([rel, bytes.subarray(at, at + size), mode]);
    at += size;
  }
  return files;
}

function loadPreload(): void {
  preloaded = new Map();
  try {
    for (const [rel, bytes, mode] of readBundle(preloadUrl!)) preloaded.set(`${mode}/${rel}`, bytes);
  } catch {
    // no bundle: files come one by one
  }
}

function syncGet(url: string, binary: boolean): { status: number; body: Uint8Array | string } {
  if (preloadUrl && installKey && url.startsWith(`${base}/nm/${installKey}/`)) {
    if (!preloaded && ++installedRequests > (thread ? PRELOAD_AFTER_THREAD : PRELOAD_AFTER)) loadPreload();
    const hit = preloaded?.get(url.slice(base.length + installKey.length + 5));
    if (hit) return { status: 200, body: binary ? hit.slice() : new TextDecoder().decode(hit) };
  }
  return requestSync(url, binary);
}

function requestSync(url: string, binary: boolean): { status: number; body: Uint8Array | string } {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  if (binary) xhr.responseType = 'arraybuffer';
  xhr.send();
  return { status: xhr.status, body: binary ? new Uint8Array(xhr.response as ArrayBuffer) : xhr.responseText };
}

let vfs: Vfs = new Vfs((path) => {
  const rel = path.slice(projectRoot.length + 1);
  const res = syncGet(`${base}/nm/${installKey}/f/${rel}`, true);
  if (res.status !== 200) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  return res.body as Uint8Array;
});

let proc: ReturnType<typeof createProcess>;
/** This runtime as a worker thread (null in the main thread). */
let thread: ThreadInit | null = null;
let tsRunner = false;
let threads: ReturnType<typeof createWorkerThreads>;
let childProcess: ReturnType<typeof createChildProcess>;
let nodeModulesIndex: Record<string, number> | null = null;

function write(stream: 'stdout' | 'stderr', text: string) {
  post({ type: 'log', stream, text });
}

/** How the SQLite modules see files: the VFS, relative to the process's working directory. */
function sqliteFiles(): FileAccess {
  return {
    exists: (p) => vfs.exists(p),
    read: (p) => vfs.read(p),
    write: (p, data) => vfs.write(p, data),
    resolve: (p) => (p.startsWith('/') ? p : pathBrowserify.resolve((proc.cwd as () => string)(), p.replace(/^file:/, ''))),
  };
}

/** Installed packages that are native addons, replaced by SQLite WebAssembly-backed modules. */
const SQLITE_PACKAGES: [RegExp, () => unknown][] = [
  [/\/node_modules\/better-sqlite3\//, () => createBetterSqlite3(sqliteFiles())],
  [/\/node_modules\/sqlite3\//, () => createSqlite3(sqliteFiles())],
];
const overrides = new Map<RegExp, unknown>();
let usesSqlite = false;
/**
 * The project uses top-level await somewhere: every project ES module is compiled as an async
 * module, so importers wait for their dependencies (see src/adapters/node/tla.ts). The host parses
 * the project's sources once to decide.
 */
let asyncModules = false;

function buildBuiltins() {
  const fs = createFs(vfs, () => (proc.cwd as () => string)());
  const path = Object.assign(Object.create(null), pathBrowserify, {
    toNamespacedPath: (p: string) => p,
    matchesGlob: () => false,
  });
  path.posix = path;
  path.win32 = path;
  // Node's path has no enumerable 'default' (tools copy its keys: @vercel/nft).
  Object.defineProperty(path, 'default', { value: path, enumerable: false, writable: true, configurable: true });

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
  // Node >= 17: Readable.fromWeb / toWeb and friends. readable-stream has them, but they call Node internals.
  const Readable = rs.Readable as unknown as Record<string, unknown>;
  Readable.fromWeb = (web: ReadableStream, opts?: object) => {
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
  Readable.toWeb = (node: NodeJS.ReadableStream) =>
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
  Writable.fromWeb = (web: WritableStream) => {
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
  Writable.toWeb = (node: NodeJS.WritableStream) =>
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
    parseArgs,
    formatWithOptions: (_options: unknown, ...args: unknown[]) => (util as unknown as { format(...a: unknown[]): string }).format(...args),
    debug: (util as unknown as { debuglog: unknown }).debuglog,
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

  // crypto-browserify predates the base64url encoding (digests are hashed ids in many tools).
  const withBase64Url = <A extends unknown[]>(make: (...a: A) => { digest(enc?: string): Buffer | string }) => (...args: A) => {
    const h = make(...args);
    const digest = h.digest.bind(h);
    h.digest = (enc?: string) => (enc === 'base64url' ? (digest() as Buffer).toString('base64url') : digest(enc));
    return h;
  };
  const createHash = withBase64Url(cryptoBrowserify.createHash as never);
  const createHmac = withBase64Url(cryptoBrowserify.createHmac as never);
  const crypto = Object.assign(Object.create(null), cryptoBrowserify, {
    createHash,
    createHmac,
    Hash: createHash,
    Hmac: createHmac,
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
    hash: (alg: string, data: string, enc: BufferEncoding = 'hex') => (createHash as unknown as (a: string) => { update(d: string): { digest(e: string): string } })(alg).update(data).digest(enc),
  });

  const zlibUnsupported = (name: string) => () => {
    throw Object.assign(new Error(`zlib.${name} (brotli/zstd) is not available in the browser runtime`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  };
  const zlib = Object.assign(Object.create(null), zlibBrowserify, typeof CompressionStream === 'function' ? nativeZlib : {}, {
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
  // browserify-zlib has its Z_* constants on the module, not on `constants`.
  const zConstants = Object.fromEntries(Object.entries(zlibBrowserify).filter(([k, v]) => k.startsWith('Z_') && typeof v === 'number'));
  zlib.constants = { ...zConstants, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_MODE: 0, BROTLI_MODE_TEXT: 1, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_PROCESS: 0 };

  const assertStrict = Object.assign((v: unknown, m?: string) => assert.strict(v, m as string), assert.strict);

  const table: Record<string, () => unknown> = {
    fs: () => fs,
    'fs/promises': () => fs.promises,
    path: () => path,
    'path/posix': () => path,
    'path/win32': () => path,
    buffer: () => ({ Buffer, SlowBuffer: Buffer, kMaxLength: 2 ** 31 - 1, kStringMaxLength: 2 ** 29, constants: { MAX_LENGTH: 2 ** 31 - 1, MAX_STRING_LENGTH: 2 ** 29 }, Blob, File, atob, btoa, isUtf8: () => true, isAscii: (b: Uint8Array) => b.every((x) => x < 128), transcode: (b: Uint8Array) => b, INSPECT_MAX_BYTES: 50 }),
    events: () => Object.assign(events, { EventEmitter, EventEmitterAsyncResource, default: events, getEventListeners: (e: EventEmitter, n: string) => e.listeners(n), setMaxListeners: () => {}, addAbortListener: (s: AbortSignal, fn: () => void) => { s.addEventListener('abort', fn); return { [Symbol.dispose]: () => s.removeEventListener('abort', fn) }; } }),
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
    net: () => net,
    tls: () => misc.tls,
    dns: () => misc.dns,
    'dns/promises': () => misc.dns.promises,
    http: () => http,
    https: () => https,
    http2: () => misc.http2,
    _http_agent: () => ({ Agent: http.Agent, globalAgent: http.globalAgent }),
    _http_common: () => ({ methods: http.METHODS }),
    child_process: () => childProcess,
    worker_threads: () => {
      // Threads may be spawned while this thread is blocked; have runtimes ready for them (see threads.ts).
      warmRuntimes(base, WARM_RUNTIMES);
      return threads.module;
    },
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
    wasi: () => createWasi(fs, write),
    test: () => misc.stub('test'),
    sqlite: () => createNodeSqlite(sqliteFiles()),
    sea: () => ({ isSea: () => false }),
  };
  return table;
}

let moduleSystem: ReturnType<typeof createModuleSystem>;
/** Runtime workers booted ahead of time for threads (see threads.ts). */
const WARM_RUNTIMES = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));

function init(msg: Extract<ToWorker, { type: 'init' }>) {
  base = msg.base;
  installKey = msg.installKey;
  preloadUrl = msg.preload ?? null;
  projectRoot = msg.cwd;
  thread = msg.thread ?? null;
  // SANDBURG_TS_RUNNER: started by the shell for tsx, ts-node … (see shell.ts).
  tsRunner = !!msg.tsRunner || msg.env?.SANDBURG_TS_RUNNER === '1';
  // A worker thread shares its parent's file system (installed packages it reads itself).
  if (thread) {
    const installed = new Vfs((path) => {
      const res = syncGet(`${base}/nm/${installKey}/f/${path.slice(projectRoot.length + 1)}`, true);
      if (res.status !== 200) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
      return res.body as Uint8Array;
    });
    for (const [rel, size] of Object.entries(msg.nodeModules ?? {})) installed.addRemote(`${msg.cwd}/${rel}`, size);
    vfs = new ThreadVfs((m) => realPostMessage(m), installed, msg.cwd, thread.snapshot);
  }
  nodeModulesIndex = msg.nodeModules;
  for (const [path, content] of Object.entries(msg.files)) {
    const abs = `${msg.cwd}/${path}`;
    vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
    vfs.write(abs, typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0)));
  }
  if (msg.filesBundle) {
    for (const [rel, bytes] of readBundle(msg.filesBundle)) {
      const abs = `${msg.cwd}/${rel}`;
      vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
      vfs.write(abs, bytes);
    }
  }
  if (!thread) for (const [rel, size] of Object.entries(msg.nodeModules ?? {})) vfs.addRemote(`${msg.cwd}/${rel}`, size);
  // SQLite's WebAssembly engine is loaded before the program runs if it may need it (the APIs are synchronous).
  if (msg.inherit) ({ usesSqlite, asyncModules } = msg.inherit);
  else usesSqlite =
    [...Object.keys(msg.nodeModules ?? {}), ...Object.keys(msg.files)].some((rel) => /(^|\/)node_modules\/(better-sqlite3|sqlite3)\/package\.json$/.test(rel)) ||
    Object.values(msg.files).some((c) => typeof c === 'string' && c.includes('node:sqlite'));
  const sources = msg.inherit ? {} : Object.fromEntries(Object.entries(msg.files).filter(([p, c]) => typeof c === 'string' && !p.includes('node_modules/') && /\.[cm]?[jt]sx?$/.test(p) && /\bawait\b/.test(c)));
  if (Object.keys(sources).length) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/tla-scan`, false);
    xhr.send(JSON.stringify(sources));
    asyncModules = xhr.status === 200 && (JSON.parse(xhr.responseText) as { topLevelAwait: boolean }).topLevelAwait;
  }
  if (!thread) vfs.mkdir('/tmp', true);
  // WebAssembly threads (napi-rs wasm32-wasi builds) may be spawned while this thread is blocked: have runtimes ready.
  if (Object.keys(msg.nodeModules ?? {}).some((rel) => /-wasm32-wasi\/package\.json$/.test(rel))) warmRuntimes(msg.base, WARM_RUNTIMES);

  const child = thread?.process;
  proc = createProcess({ cwd: msg.cwd, env: { NODE_ENV: 'development', HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', ...msg.env }, argv: ['/usr/local/bin/node'], write, send: msg.ipc || child?.ipc ? (data) => post({ type: 'message', data }) : undefined });
  if (child) {
    (proc.chdir as (d: string) => void)(child.cwd);
    proc.execArgv = child.execArgv;
    // A child process's environment is exactly what its parent passed.
    proc.env = { ...msg.env };
  }
  const nested: ThreadHost = {
    vfs: () => vfs,
    childInit: (t) => ({ type: 'init', cwd: projectRoot, env: t.env, files: {}, installKey, preload: preloadUrl, nodeModules: nodeModulesIndex, base, tsRunner, thread: t, inherit: { asyncModules, usesSqlite } }),
    write,
    cwd: () => (proc.cwd as () => string)(),
    root: () => projectRoot,
    env: () => proc.env as Record<string, string>,
    resolvePath: (p) => (p.startsWith('/') ? p : pathBrowserify.resolve((proc.cwd as () => string)(), p)),
    base: () => base,
    // A child process is a main thread of its own.
    self: child ? null : thread,
    postToParent: (m, transfer) => realPostMessage(m as FromWorker, transfer ?? []),
    relay: relayFromNested,
  };
  threads = createWorkerThreads(nested);
  childProcess = createChildProcess({ ...nested, execPath: () => proc.execPath as string, reportExit: (info) => post({ type: 'process-exit', ...info }) });
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
  const hostCompile = (code: string, path: string, kind: 'esm' | 'cjs' | 'ts'): string => {
    const key = `${kind}:${path}:${code.length}:${hash(code)}`;
    const hit = compiledCache.get(key);
    if (hit !== undefined) return hit;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/compile?kind=${kind}&path=${encodeURIComponent(path)}${asyncModules && kind !== 'cjs' ? '&async=1' : ''}`, false);
    xhr.send(code);
    if (xhr.status !== 200) throw Object.assign(new SyntaxError(xhr.responseText), { code: 'ERR_COMPILE' });
    compiledCache.set(key, xhr.responseText);
    return xhr.responseText;
  };
  moduleSystem = createModuleSystem({
    vfs,
    tsRunner,
    conditions: child?.conditions,
    packageOverride(filename: string) {
      for (const [pattern, make] of SQLITE_PACKAGES) {
        if (!pattern.test(filename)) continue;
        if (!overrides.has(pattern)) overrides.set(pattern, make());
        return overrides.get(pattern);
      }
      return undefined;
    },
    compiledNodeModule(path: string) {
      if (!installKey) return null;
      const rel = path.slice(projectRoot.length + 1);
      // A file the program wrote itself (Vite's node_modules/.vite-temp/…): the host has no transform of it.
      if (nodeModulesIndex && !(rel in nodeModulesIndex)) return null;
      const res = syncGet(`${base}/nm/${installKey}/t/${rel}`, false);
      return res.status === 200 ? (res.body as string) : null;
    },
    compile: hostCompile,
    builtin,
    builtinNames: [...Object.keys(table), 'module'],
    prefixOnly: new Set(['test', 'sqlite', 'sea', 'test/reporters']),
    process: proc as unknown as { dlopen(m: unknown, f: string): void },
    cwd: () => (proc.cwd as () => string)(),
    argv1: () => (proc.argv as string[])[1],
  } as never);

  // `new AsyncFunction(…params, body)` with the body lowered like all other code (see interop.ts).
  const RealAsyncFunction = new Function('return (async function () {}).constructor')() as FunctionConstructor;
  /** Names evaluated code in stack traces after the file its inline source map is for (Vite's SSR modules). */
  const sourceUrlOf = (code: string): string => {
    const named = /\/\/[#@] sourceURL=(\S+)\s*$/m.exec(code);
    if (named) return `\n//# sourceURL=${named[1]}`;
    const map = /\/\/[#@] sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/m.exec(code);
    if (!map) return '';
    try {
      const { sources, file } = JSON.parse(atob(map[1])) as { sources?: string[]; file?: string };
      const name = sources?.[0] ?? file;
      return name ? `\n//# sourceURL=${name}` : '';
    } catch {
      return '';
    }
  };
  function AsyncFunction(...args: unknown[]) {
    const body = args.length ? String(args.pop()) : '';
    const params = args.map(String).join(',');
    try {
      const js = hostCompile(`module.exports = async function anonymous(${params}\n) {\n${body}\n};`, '/[eval]', 'cjs');
      const m = { exports: undefined as unknown };
      new Function('module', js + sourceUrlOf(body))(m);
      return m.exports;
    } catch {
      return new RealAsyncFunction(...(args as string[]), body);
    }
  }
  AsyncFunction.prototype = RealAsyncFunction.prototype;
  (globalThis as Record<symbol, unknown>)[Symbol.for('sandburg.AsyncFunction')] = AsyncFunction;
  // import() inside a Function constructor's source (see interop.ts): resolved from the working directory.
  Object.defineProperty(globalThis, '__sandburg_import', {
    configurable: true,
    value: (specifier: string) =>
      Promise.resolve().then(() => {
        const spec = String(specifier).startsWith('file:') ? decodeURIComponent(new URL(String(specifier)).pathname) : String(specifier);
        // An import(), so resolved with import conditions (as from an ES module).
        type Mod = { filename: string; paths: string[]; esm: boolean };
        const M = moduleSystem.Module as unknown as { new (id: string, parent: null): Mod; _nodeModulePaths(d: string): string[]; _load(r: string, p: Mod, main: boolean): unknown };
        const cwd = (proc.cwd as () => string)();
        const parent = new M(`${cwd}/[import]`, null);
        parent.filename = `${cwd}/[import]`;
        parent.paths = M._nodeModulePaths(cwd);
        parent.esm = true;
        const mod = M._load(spec, parent, false) as Record<string, unknown> | null;
        if (mod && typeof mod === 'object' && (mod.__esModule || (globalThis as Record<symbol, WeakSet<object>>)[Symbol.for('sandburg.esm')]?.has(mod))) return mod;
        return Object.assign(Object.create(null), mod && typeof mod === 'object' ? mod : {}, { default: mod });
      }),
  });

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
  installNodeFetchClasses(g);
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
    // process.exit() from a callback (timer, I/O) ends the process there too.
    if (e.error instanceof ExitError) {
      e.preventDefault();
      return post({ type: 'exit', code: e.error.code });
    }
    // In a worker thread an uncaught exception ends the thread ('error' on its Worker), as in Node.
    if (thread && !proc.listenerCount('uncaughtException')) {
      e.preventDefault();
      return post({ type: 'fatal', message: String(e.error?.message ?? e.message), stack: e.error?.stack });
    }
    if ((proc.env as Record<string, string>).SANDBURG_DEBUG_ERRORS) write('stderr', `[sandburg] uncaught: ${e.error?.stack ?? e.message}\n`);
    if (proc.listenerCount('uncaughtException')) {
      e.preventDefault();
      proc.emit('uncaughtException', e.error, 'uncaughtException');
    }
  });
  self.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof ExitError) {
      e.preventDefault();
      return post({ type: 'exit', code: e.reason.code });
    }
    if (proc.listenerCount('unhandledRejection')) {
      e.preventDefault();
      proc.emit('unhandledRejection', e.reason, e.promise);
    } else {
      write('stderr', `Uncaught (in promise) ${e.reason?.stack ?? e.reason}\n`);
    }
  });
  serverEvents.on('listening', (port: number | string) => announce(port));
  installNodeMessagePorts();
  hideWorkerGlobals();
  post({ type: 'ready' });
  // A worker thread starts its entry right away: its parent may be blocked in Atomics.wait until it runs.
  if (thread) run({ type: 'run', main: thread.main, argv: thread.argv, preload: thread.process?.preload });
  if (thread?.process) exitWhenIdle();
}

const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

/**
 * A child process ends when its event loop has nothing left to do, as in Node: no ref'd timers or
 * immediates, servers, sockets, IPC channel, threads or children, or in-flight fetches. Work the
 * runtime cannot see (a pending WebAssembly compile, say) is covered by waiting for the loop to stay
 * idle for a while.
 */
function exitWhenIdle() {
  const track = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...args: A): Promise<R> => {
    pendingWork.count++;
    return fn(...args).finally(() => pendingWork.count--);
  };
  globalThis.fetch = track(globalThis.fetch.bind(globalThis));
  const wasm = WebAssembly as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) if (wasm[name]) wasm[name] = track(wasm[name].bind(WebAssembly));
  const busy = () => timersActive() || servers.size > 0 || netServers.size > 0 || netConns.size > 0 || sockets.size > 0 || !!proc.connected || liveRuntimes.size > 0;
  let idle = 0;
  const timer = nativeSetInterval(() => {
    idle = busy() ? 0 : idle + 1;
    if (idle < 8) return;
    idle = 0;
    const code = Number(proc.exitCode ?? 0);
    try {
      proc.emit('beforeExit', code);
      if (busy()) return;
      nativeClearInterval(timer);
      (proc.exit as (c: number) => void)(Number(proc.exitCode ?? 0));
    } catch (e) {
      nativeClearInterval(timer);
      post({ type: 'exit', code: e instanceof ExitError ? e.code : 1 });
    }
  }, 25);
}

function run(msg: Extract<ToWorker, { type: 'run' }>) {
  if (!usesSqlite) return start(msg);
  loadSqlite(base, realImportScripts).then(
    () => start(msg),
    (e) => post({ type: 'fatal', message: `runtime asset failed to load: SQLite WebAssembly (${(e as Error)?.message ?? e})` }),
  );
}

function start(msg: Extract<ToWorker, { type: 'run' }>) {
  proc.argv = ['/usr/local/bin/node', msg.main, ...(msg.argv ?? [])];
  // The main program ends like a child process does: when nothing is left to do (a CLI that exits).
  if (!thread) exitWhenIdle();
  try {
    // --require / --import (loaded in order, before the entry).
    for (const p of msg.preload ?? []) (moduleSystem.Module as unknown as { _load(r: string, p: null, m: boolean): unknown })._load(p, null, false);
    const exports = (moduleSystem.Module as unknown as { _load(r: string, p: null, m: boolean): unknown })._load(msg.main, null, true);
    // An async main module (top-level await): a rejection ends the process like an uncaught exception.
    const tla = (exports as Record<string, unknown> | null)?.__sandburg_tla as Promise<unknown> | undefined;
    if (tla && typeof tla.then === 'function') {
      tla.catch((e: unknown) => {
        if (e instanceof ExitError) return post({ type: 'exit', code: e.code });
        post({ type: 'fatal', message: String((e as Error)?.message ?? e), stack: (e as Error)?.stack });
      });
    }
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

self.addEventListener('message', (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    adoptMailboxes(e.ports, msg.thread?.mailboxes);
    init(msg);
  }
  else if (msg.type === 'run') run(msg);
  else if (msg.type === 'request' && !servers.has(msg.port) && nestedPorts.has(msg.port)) nestedPorts.get(msg.port)!.postMessage(msg, msg.body ? [msg.body] : []);
  else if (msg.type === 'request') request(msg);
  else if (msg.type === 'ws-open' && !servers.has(msg.port) && nestedPorts.has(msg.port)) {
    nestedSockets.set(msg.id, nestedPorts.get(msg.port)!);
    nestedSockets.get(msg.id)!.postMessage(msg);
  } else if ((msg.type === 'ws-send' || msg.type === 'ws-close') && nestedSockets.has(msg.id)) nestedSockets.get(msg.id)!.postMessage(msg);
  else if (msg.type.startsWith('net-')) netMessage(msg as NetMessage, (x, t) => realPostMessage(x, t ?? []), null);
  else if (msg.type === 'disconnect' && proc?.connected) {
    proc.connected = false;
    proc.emit('disconnect');
  }
  else if (msg.type === 'message') proc?.emit('message', msg.data);
  else if (msg.type === 'wt-message') {
    adoptMailboxes(e.ports, msg.mailboxes);
    threads.deliver(msg.data);
  }
  else if (msg.type === 'ws-open') wsOpen(msg);
  else if (msg.type.startsWith('lb-')) loopbackReply(msg as Extract<ToWorker, { type: `lb-${string}` }>);
  else if (msg.type === 'read-tree') {
    const files: Record<string, string | { base64: string }> = {};
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const walk = (dir: string) => {
      for (const name of vfs.readdir(dir)) {
        const path = `${dir}/${name}`;
        const st = vfs.stat(path);
        if (st.kind === 'dir') walk(path);
        else if (st.size < 64 << 20) {
          const bytes = vfs.read(path);
          let text: string | null = null;
          try {
            text = utf8.decode(bytes);
          } catch {
            // binary (webpack's cache packs)
          }
          files[path.slice(projectRoot.length + 1)] = text ?? { base64: Buffer.from(bytes).toString('base64') };
        }
      }
    };
    for (const dir of msg.dirs) {
      try {
        walk(`${projectRoot}/${dir}`);
      } catch {
        // not there
      }
    }
    post({ type: 'tree', id: msg.id, files });
  }
    else if (msg.type === 'write-file') {
    const abs = msg.path.startsWith('/') ? msg.path : `${projectRoot}/${msg.path}`;
    vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
    vfs.write(abs, new TextEncoder().encode(msg.content));
  }
  else if (msg.type === 'ws-send') {
    const c = sockets.get(msg.id);
    if (c?.codec.isOpen) c.socket.receive(c.codec.send(typeof msg.data === 'string' ? msg.data : new Uint8Array(msg.data)));
  } else if (msg.type === 'ws-close') {
    const c = sockets.get(msg.id);
    if (c?.codec.isOpen) c.socket.receive(c.codec.close(msg.code ?? 1000, msg.reason ?? ''));
    else if (c) c.socket.hangUp();
  }
});

const sockets = new Map<number, { socket: UpgradeSocket; codec: WsClientCodec }>();

/**
 * net connections between runtimes (see net.ts): a socket here, its peer in the parent or a nested
 * runtime. A connection starts with net-connect to the runtime that has the server; then either
 * side sends data, end (half close) and close.
 */
type NetMessage =
  | { type: 'net-connect'; id: number; key: number | string }
  | { type: 'net-connected'; id: number }
  | { type: 'net-refused'; id: number; message: string }
  | { type: 'net-data'; id: number; data: ArrayBuffer }
  | { type: 'net-end'; id: number }
  | { type: 'net-close'; id: number }
  | { type: 'net-listening'; key: number | string };
type Send = (m: NetMessage, transfer?: Transferable[]) => void;
const netConns = new Map<number, NetSocket>();
/** Net servers in nested runtimes. */
const nestedNet = new Map<number | string, globalThis.Worker>();
let nextNetId = -1 - Math.floor(Math.random() * 2 ** 40);

function bindRemote(socket: NetSocket, id: number, send: Send) {
  netConns.set(id, socket);
  socket.peer = {
    data: (chunk) => {
      const buf = chunk.slice().buffer as ArrayBuffer;
      send({ type: 'net-data', id, data: buf }, [buf]);
    },
    end: () => send({ type: 'net-end', id }),
    close: () => {
      netConns.delete(id);
      send({ type: 'net-close', id });
    },
  };
  socket.once('close', () => netConns.delete(id));
}

netLinks.connect = (key, socket) => {
  const nested = nestedNet.get(key);
  // A server in a nested runtime, else ask the parent (it may have one).
  const send: Send | null = nested ? (m, t) => nested.postMessage(m, t ?? []) : thread ? (m, t) => realPostMessage(m, t ?? []) : null;
  if (!send) return false;
  const id = nextNetId--;
  bindRemote(socket, id, send);
  send({ type: 'net-connect', id, key });
  return true;
};
netEvents.on('listening', (key: number | string) => {
  if (thread) realPostMessage({ type: 'net-listening', key } satisfies NetMessage);
});

/** A net message from another runtime; `reply` goes back to it. */
function netMessage(m: NetMessage, reply: Send, from: globalThis.Worker | null): void {
  switch (m.type) {
    case 'net-connect': {
      const server = netServers.get(m.key);
      if (!server) return reply({ type: 'net-refused', id: m.id, message: `connect ECONNREFUSED ${typeof m.key === 'string' ? m.key : `127.0.0.1:${m.key}`}` });
      const socket = new NetSocket();
      bindRemote(socket, m.id, reply);
      socket.connecting = false;
      socket.pending = false;
      server.accept(socket);
      return reply({ type: 'net-connected', id: m.id });
    }
    case 'net-connected':
      return void netConns.get(m.id)?.established();
    case 'net-refused': {
      const socket = netConns.get(m.id);
      netConns.delete(m.id);
      return socket?.refuse(m.message);
    }
    case 'net-data':
      return netConns.get(m.id)?.receive(new Uint8Array(m.data));
    case 'net-end':
      return netConns.get(m.id)?.receive(null);
    case 'net-close': {
      const socket = netConns.get(m.id);
      netConns.delete(m.id);
      if (socket) {
        socket.peer = null;
        socket.destroy();
      }
      return;
    }
    case 'net-listening':
      if (from) nestedNet.set(m.key, from);
      return;
  }
}

/**
 * Servers in nested runtimes (child processes, worker threads) are reachable like this runtime's own:
 * requests and WebSockets for their ports go down to them, and their replies come back up.
 */
const nestedPorts = new Map<number | string, globalThis.Worker>();
const nestedSockets = new Map<number, globalThis.Worker>();
/** Requests this runtime's programs made to servers in nested runtimes (http.request to localhost). */
const loopbackRequests = new Map<number, BridgeResponse & { error(message: string, code?: string): void }>();
let nextLoopbackId = -1 - Math.floor(Math.random() * 2 ** 40);
/**
 * A request to a server this runtime does not run: down to the nested runtime that runs it, else up
 * to the parent, which looks among its own servers and its other children (a Vite dev server
 * proxying /api to a backend that the same dev script started).
 */
loopback.route = (target, method, url, headers, body, bridge) => {
  const worker = nestedPorts.get(target);
  if (!worker && !thread) return false;
  const id = nextLoopbackId--;
  loopbackRequests.set(id, bridge);
  const buf = body ? (body.slice().buffer as ArrayBuffer) : null;
  const msg = { id, port: target, method, url, headers, body: buf };
  if (worker) worker.postMessage({ type: 'request', ...msg } satisfies ToWorker, buf ? [buf] : []);
  else realPostMessage({ type: 'lb-request', ...msg }, buf ? [buf] : []);
  return true;
};

/** The parent's reply to a request sent up by loopback.route. */
function loopbackReply(m: Extract<ToWorker, { type: `lb-${string}` }>) {
  const bridge = loopbackRequests.get(m.id);
  if (!bridge) return;
  if (m.type === 'lb-start') bridge.start(m.status, m.statusText, m.headers);
  else if (m.type === 'lb-chunk') bridge.chunk(new Uint8Array(m.chunk));
  else {
    loopbackRequests.delete(m.id);
    if (m.type === 'lb-end') bridge.end();
    else bridge.error(m.message, m.code);
  }
}

/** A loopback request from a nested runtime: served here, or routed on (see loopback.route). */
function loopbackRequest(m: { id: number; port: number | string; method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }, from: globalThis.Worker) {
  const reply = (x: ToWorker, t: Transferable[] = []) => from.postMessage(x, t);
  const id = m.id;
  const bridge = {
    start: (status: number, statusText: string, headers: [string, string][]) => reply({ type: 'lb-start', id, status, statusText, headers }),
    chunk: (data: Uint8Array) => {
      const chunk = data.slice().buffer as ArrayBuffer;
      reply({ type: 'lb-chunk', id, chunk }, [chunk]);
    },
    end: () => reply({ type: 'lb-end', id }),
    error: (message: string, code?: string) => reply({ type: 'lb-error', id, message, code }),
  };
  const body = m.body ? new Uint8Array(m.body) : null;
  const server = servers.get(m.port);
  try {
    if (server) server.dispatch(m.method, m.url, m.headers, body, bridge);
    else if (nestedPorts.get(m.port) === from || !loopback.route!(m.port, m.method, m.url, m.headers, body, bridge)) {
      bridge.error(`connect ECONNREFUSED ${typeof m.port === 'string' ? m.port : `127.0.0.1:${m.port}`}`, 'ECONNREFUSED');
    }
  } catch (e) {
    bridge.error(String((e as Error)?.message ?? e));
  }
}
/** Only TCP ports are the host's business; a nested runtime's parent also learns its socket paths. */
const announce = (port: number | string) => {
  if (typeof port === 'number' || thread) post({ type: 'listening', port });
};
function relayFromNested(m: { type: string; [k: string]: unknown }, from: globalThis.Worker): boolean {
  if (m.type.startsWith('net-')) {
    netMessage(m as unknown as NetMessage, (x, t) => from.postMessage(x, t ?? []), from);
    return true;
  }
  const own = loopbackRequests.get(m.id as number);
  if (own && m.type.startsWith('response-')) {
    if (m.type === 'response-start') own.start(m.status as number, m.statusText as string, m.headers as [string, string][]);
    else if (m.type === 'response-chunk') own.chunk(m.chunk as Uint8Array);
    else {
      loopbackRequests.delete(m.id as number);
      if (m.type === 'response-end') own.end();
      else own.error(String(m.message));
    }
    return true;
  }
  switch (m.type) {
    case 'process-exit':
      post(m as FromWorker);
      return true;
    case 'lb-request':
      loopbackRequest(m as unknown as Parameters<typeof loopbackRequest>[0], from);
      return true;
    case 'listening':
      nestedPorts.set(m.port as number | string, from);
      announce(m.port as number | string);
      return true;
    case 'response-chunk':
      post(m as FromWorker, [(m.chunk as Uint8Array).buffer as ArrayBuffer]);
      return true;
    case 'response-start':
    case 'response-end':
    case 'response-error':
    case 'ws-accept':
    case 'ws-message':
      post(m as FromWorker);
      return true;
    case 'ws-reject':
    case 'ws-closed':
      nestedSockets.delete(m.id as number);
      post(m as FromWorker);
      return true;
  }
  return false;
}

/** Opens a WebSocket to a virtual server: an upgrade request, then the WebSocket protocol over the socket. */
function wsOpen(msg: Extract<ToWorker, { type: 'ws-open' }>) {
  const server = servers.get(msg.port);
  const id = msg.id;
  // The server may write (and so the client reply, e.g. pong) inside its 'upgrade' handler, before upgrade() returns.
  let early: Uint8Array[] | null = [];
  const codec = new WsClientCodec({
    accept: (protocol, extensions) => post({ type: 'ws-accept', id, protocol, extensions }),
    reject: (status, message) => {
      sockets.delete(id);
      post({ type: 'ws-reject', id, status, message });
    },
    message: (data) => {
      if (typeof data === 'string') post({ type: 'ws-message', id, data });
      else post({ type: 'ws-message', id, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
    },
    closed: (code, reason, wasClean) => {
      sockets.get(id)?.socket.hangUp();
      sockets.delete(id);
      post({ type: 'ws-closed', id, code, reason, wasClean });
    },
    reply: (bytes) => (early ? early.push(bytes) : sockets.get(id)?.socket.receive(bytes)),
  });
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const headers: [string, string][] = [
    ...msg.headers,
    ['upgrade', 'websocket'],
    ['connection', 'Upgrade'],
    ['sec-websocket-key', key],
    ['sec-websocket-version', '13'],
    ...(msg.protocols.length ? [['sec-websocket-protocol', msg.protocols.join(', ')] as [string, string]] : []),
  ];
  const socket = server?.upgrade(msg.url, headers, { data: (bytes) => codec.receive(bytes), end: () => codec.end() });
  if (!socket) return post({ type: 'ws-reject', id, status: 404, message: server ? 'the server does not accept WebSocket connections' : `nothing listening on port ${msg.port}` });
  sockets.set(id, { socket, codec });
  for (const bytes of early) socket.receive(bytes);
  early = null;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const RUNTIME_NODE_VERSION = NODE_VERSION;

// Ready for an init message (a parent keeps booted runtimes for its threads: see threads.ts).
realPostMessage({ type: 'booted' });
