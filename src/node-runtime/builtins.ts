/**
 * The runtime's built-in modules (node:fs, node:stream, node:util, …), built once per runtime by
 * init (worker.ts) from the polyfills and the runtime's own modules (builtins/).
 */
import { Buffer } from 'buffer';
import { wakeSpares, warmRuntimes } from './threads.ts';
import { createWasi } from './builtins/wasi.ts';
import { createNodeSqlite } from './builtins/sqlite/node-sqlite.ts';
import events, { EventEmitter } from 'events';
import * as rs from 'readable-stream';
import util from 'util';
import assert from 'assert';
import pathBrowserify from 'path-browserify';
import * as legacyUrl from 'url';
import querystring from 'querystring-es3';
import * as stringDecoder from 'string_decoder';
import { nativeZlib, useZlibPort } from './builtins/zlib-native.ts';
import { parseArgs } from '@pkgjs/parseargs';
import { asyncHooks, EventEmitterAsyncResource } from './async-context.ts';
import { createFs } from './builtins/fs.ts';
import { http, https } from './builtins/http.ts';
import { timers, timersPromises } from './builtins/process.ts';
import * as misc from './builtins/misc.ts';
import { net } from './builtins/net.ts';
import { Hash, Hmac, hashAlgorithm } from './builtins/hash.ts';
import { CRYPTO_LIB_KEYS, ZLIB_CONSTANTS, ZLIB_LIB_KEYS } from './libs.ts';
import { vfs, proc, runtimeLib, lazyMember, childProcess, wasiChildThread, base, WARM_RUNTIMES, threads, thread, write, sqliteFiles } from './worker.ts';

export function buildBuiltins() {
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
        // A stream that errored rejects its cancel(): the error is already err (read() above).
        reader.cancel(err).then(() => cb(err), () => cb(err));
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

  // node:crypto: hashes, HMACs and random bytes here (builtins/hash.ts); the rest is crypto-browserify,
  // a runtime library loaded the first time a program uses one of its members.
  const makeCrypto = () => {
    const lib = () => runtimeLib<Record<string, unknown>>('crypto');
    // crypto-browserify predates the base64url encoding (digests are hashed ids in many tools).
    const withBase64Url = <A extends unknown[]>(make: (...a: A) => { digest(enc?: string): Buffer | string }) => (...args: A) => {
      const h = make(...args);
      const digest = h.digest.bind(h);
      h.digest = (enc?: string) => (enc === 'base64url' ? (digest() as Buffer).toString('base64url') : digest(enc));
      return h;
    };
    const createHash = (alg: string, options?: unknown) => {
      const name = hashAlgorithm(alg);
      if (name) return new Hash(name);
      try {
        return withBase64Url(lib().createHash as (a: string, o?: unknown) => { digest(enc?: string): Buffer | string })(alg, options);
      } catch {
        throw new Error('Digest method not supported');
      }
    };
    const createHmac = (alg: string, key: unknown, options?: unknown) => {
      const name = hashAlgorithm(alg);
      if (name) return new Hmac(name, key);
      try {
        return withBase64Url(lib().createHmac as (a: string, k: unknown, o?: unknown) => { digest(enc?: string): Buffer | string })(alg, key, options);
      } catch {
        throw Object.assign(new TypeError(`Invalid digest: ${alg}`), { code: 'ERR_CRYPTO_INVALID_DIGEST' });
      }
    };
    const randomFillSync = <T extends ArrayBufferView>(buf: T, offset = 0, size?: number): T => {
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const end = size === undefined ? bytes.length : offset + size;
      if (!(offset >= 0 && end <= bytes.length && offset <= end)) throw Object.assign(new RangeError('The value of "offset" or "size" is out of range.'), { code: 'ERR_OUT_OF_RANGE' });
      // getRandomValues fills at most 64 KiB at a time.
      for (let at = offset; at < end; at += 65536) globalThis.crypto.getRandomValues(bytes.subarray(at, Math.min(end, at + 65536)) as Uint8Array<ArrayBuffer>);
      return buf;
    };
    const randomBytes = (size: number, cb?: (err: Error | null, buf?: Buffer) => void) => {
      if (typeof size !== 'number' || !(size >= 0 && size <= 2 ** 31 - 1) || !Number.isInteger(size)) {
        throw Object.assign(new RangeError(`The value of "size" is out of range. It must be >= 0 && <= ${2 ** 31 - 1}. Received ${String(size)}`), { code: typeof size === 'number' ? 'ERR_OUT_OF_RANGE' : 'ERR_INVALID_ARG_TYPE' });
      }
      const buf = randomFillSync(Buffer.allocUnsafe(size));
      if (typeof cb !== 'function') return buf;
      queueMicrotask(() => cb(null, buf));
    };
    const randomFill = <T extends ArrayBufferView>(buf: T, ...rest: unknown[]) => {
      const cb = rest.pop() as (err: Error | null, buf?: T) => void;
      const filled = randomFillSync(buf, rest[0] as number | undefined, rest[1] as number | undefined);
      queueMicrotask(() => cb(null, filled));
    };
    // crypto-browserify's other members, from the library when first used (its keys, in its order:
    // a test checks them against the library).
    const crypto = Object.create(null) as Record<string, unknown>;
    for (const key of CRYPTO_LIB_KEYS) lazyMember(crypto, key, lib);
    Object.assign(crypto, {
      createHash,
      createHmac,
      Hash: createHash,
      Hmac: createHmac,
      randomBytes,
      pseudoRandomBytes: randomBytes,
      rng: randomBytes,
      prng: randomBytes,
      randomFillSync,
      randomFill,
      webcrypto: globalThis.crypto,
      subtle: globalThis.crypto.subtle,
      getRandomValues: <T extends ArrayBufferView>(a: T) => globalThis.crypto.getRandomValues(a as never) as T,
      randomUUID: () => globalThis.crypto.randomUUID(),
      randomInt: (min: number, max?: number) => {
        if (max === undefined) [min, max] = [0, min];
        return min + Math.floor(Math.random() * (max - min));
      },
      timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]),
      getHashes: () => ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'],
      getCiphers: () => [],
      constants: {},
      hash: (alg: string, data: string, enc: BufferEncoding = 'hex') => (createHash as unknown as (a: string) => { update(d: string): { digest(e: string): string } })(alg).update(data).digest(enc),
    });
    return crypto;
  };

  // node:zlib: native streams over browserify-zlib, a runtime library loaded the first time a program
  // uses one of its members (its sync functions, classes, a stream that is flushed): Vite requires
  // zlib as it starts and does not use it in dev.
  const makeZlib = () => {
    const lib = () => runtimeLib<Record<string, unknown>>('zlib');
    useZlibPort(lib as never);
    const zlibUnsupported = (name: string) => () => {
      throw Object.assign(new Error(`zlib.${name} (brotli/zstd) is not available in the browser runtime`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
    };
    const zlib = Object.create(null) as Record<string, unknown>;
    for (const key of ZLIB_LIB_KEYS) lazyMember(zlib, key, lib);
    // zlib's Z_* constants on the module too, as browserify-zlib has them (and on `constants`).
    Object.assign(zlib, ZLIB_CONSTANTS, typeof CompressionStream === 'function' ? nativeZlib : {}, {
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
    zlib.constants = { ...ZLIB_CONSTANTS, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_MODE: 0, BROTLI_MODE_TEXT: 1, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_PROCESS: 0 };
    return zlib;
  };

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
    crypto: makeCrypto,
    zlib: makeZlib,
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
      if (!wasiChildThread()) warmRuntimes(base, WARM_RUNTIMES);
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
    wasi: () => {
      // A WebAssembly build is about to start its threads (see threads.ts). Not in one of its threads:
      // they load it too, and start none.
      if (!thread || thread.process) wakeSpares();
      return createWasi(fs, write, runtimeLib<{ WASI: unknown }>('wasi').WASI);
    },
    test: () => misc.stub('test'),
    sqlite: () => createNodeSqlite(sqliteFiles()),
    sea: () => ({ isSea: () => false }),
  };
  return table;
}
