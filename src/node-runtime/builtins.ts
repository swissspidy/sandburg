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
import { qsEscape, qsUnescape, unescapeBuffer } from './builtins/querystring.ts';
import { punycode } from './builtins/punycode.ts';
import { PROMISIFY_CUSTOM, received, timers, timersPromises } from './builtins/process.ts';
import * as misc from './builtins/misc.ts';
import { net } from './builtins/net.ts';
import { Hash, Hmac, hashAlgorithm, ripemdName } from './builtins/hash.ts';
import { scrypt, scryptSync } from './builtins/scrypt.ts';
import { CONSTANTS, getCiphers, getCurves, getHashes, makeHkdf, timingSafeEqual } from './builtins/crypto-extra.ts';
import type * as CryptoKeys from './builtins/crypto-keys.ts';
import { CRYPTO_KEYS_KEY, CRYPTO_LIB_KEYS, ZLIB_CONSTANTS, ZLIB_LIB_KEYS } from './libs.ts';
import { FsError } from './vfs.ts';
import { stdinInput, vfs, proc, runtimeLib, lazyMember, childProcess, wasiChildThread, base, WARM_RUNTIMES, threads, thread, write, sqliteFiles } from './worker.ts';

export function buildBuiltins() {
  const fs = createFs(vfs, () => (proc.cwd as () => string)(), write, () => stdinInput);
  // What the process does with files. chdir: to a directory that exists, as Node's (its error names
  // where the process is, and the directory as given).
  const setCwd = proc.chdir as (dir: string) => void;
  proc.chdir = (dir: string) => {
    const kind = typeof dir === 'string' ? vfs.kind(pathBrowserify.resolve((proc.cwd as () => string)(), dir)) : 'dir';
    if (kind !== 'dir') {
      const code = kind ? 'ENOTDIR' : 'ENOENT';
      const from = (proc.cwd as () => string)();
      throw Object.assign(new Error(`${code}: ${kind ? 'not a directory' : 'no such file or directory'}, chdir '${from}' -> '${dir}'`), { errno: kind ? -20 : -2, code, syscall: 'chdir', path: from, dest: dir });
    }
    setCwd(dir);
  };
  // loadEnvFile: the file's variables, but those the environment has already.
  proc.loadEnvFile = (path: string | URL | Buffer = '.env') => {
    if (!fs.existsSync(path)) throw new FsError('ENOENT', 'open', String(path));
    const env = proc.env as Record<string, string>;
    for (const [key, value] of Object.entries(misc.parseEnv(fs.readFileSync(path, 'utf8') as string))) env[key] ??= value;
  };
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
  type StreamLike = { readable?: boolean; writable?: boolean; readableEnded?: boolean; writableEnded?: boolean; destroyed?: boolean; _readableState?: { destroyed?: boolean }; _writableState?: { destroyed?: boolean }; on?: unknown; pipe?: unknown; write?: unknown } | null | undefined;
  // As Node's: null for what is not a Node stream.
  function isDestroyed(s: StreamLike): boolean | null {
    const isStream = !!s && (!!s._readableState || !!s._writableState || (typeof s.on === 'function' && (typeof s.pipe === 'function' || typeof s.write === 'function')));
    if (!isStream) return null;
    return !!(s.destroyed || (s._writableState ?? s._readableState)?.destroyed);
  }
  /**
   * Two Duplex streams, each one's writes the other's reads (stream.duplexPair), as Node 24's
   * (lib/internal/streams/duplexpair.js): a write completes once the other side reads it, end waits
   * for the other side's 'end', and destroying a side ends the other (or destroys it, for an error).
   */
  function duplexPair(options?: object): [InstanceType<typeof rs.Duplex>, InstanceType<typeof rs.Duplex>] {
    type Side = InstanceType<typeof rs.Duplex>;
    const peers = new Map<Side, Side>();
    const pending = new Map<Side, () => void>();
    const nextTick = (fn: () => void) => (globalThis as unknown as { process: { nextTick(fn: () => void): void } }).process.nextTick(fn);
    const side = (): Side =>
      new rs.Duplex({
        ...options,
        read() {
          const resume = pending.get(this);
          pending.delete(this);
          resume?.();
        },
        write(chunk: Uint8Array, _encoding, cb) {
          const peer = peers.get(this)!;
          if (chunk.length === 0) return nextTick(cb);
          peer.push(chunk);
          pending.set(peer, cb);
        },
        final(cb) {
          const peer = peers.get(this)!;
          peer.on('end', cb);
          peer.push(null);
        },
        destroy(err, cb) {
          const peer = peers.get(this);
          if (peer && !peer.destroyed) {
            nextTick(() => {
              if (peer.destroyed) return;
              // As Node's: the other side is destroyed without the error (no unhandled 'error' there).
              if (err) peer.destroy();
              else peer.push(null);
            });
          }
          cb(err);
        },
      });
    const a = side();
    const b = side();
    peers.set(a, b);
    peers.set(b, a);
    return [a, b];
  }
  const stream = Object.assign(Stream as unknown as Record<string, unknown>, rs, {
    Stream,
    promises: rs.promises ?? { pipeline: util.promisify(rs.pipeline), finished: util.promisify(rs.finished) },
    isReadable: (s: StreamLike) => (typeof s?.readable !== 'boolean' ? null : !isDestroyed(s) && s.readable && !s.readableEnded),
    isWritable: (s: StreamLike) => (typeof s?.writable !== 'boolean' ? null : !isDestroyed(s) && s.writable && !s.writableEnded),
    isDestroyed,
    isErrored: (s: { errored?: unknown }) => !!s?.errored,
    duplexPair,
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
    types: { ...(util as unknown as { types?: object }).types, isPromise: (v: unknown) => v instanceof Promise, isUint8Array: (v: unknown) => v instanceof Uint8Array, isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer, isArrayBufferView: ArrayBuffer.isView, isNativeError: (v: unknown) => v instanceof Error, isProxy: () => false, isExternal: () => false, isBoxedPrimitive: () => false, isModuleNamespaceObject: () => false,
      // A KeyObject is node:crypto's (looked up only for what says it is one: crypto's library loads with it).
      isKeyObject: (v: unknown) => {
        if (Object.prototype.toString.call(v) !== '[object KeyObject]') return false;
        const KeyObject = (cryptoModule() as { KeyObject?: abstract new (...a: never[]) => unknown }).KeyObject;
        return typeof KeyObject === 'function' && v instanceof KeyObject;
      },
      isCryptoKey: (v: unknown) => typeof CryptoKey === 'function' && v instanceof CryptoKey,
      isFloat16Array: (v: unknown) => typeof (globalThis as { Float16Array?: unknown }).Float16Array === 'function' && v instanceof (globalThis as unknown as { Float16Array: new () => unknown }).Float16Array,
    },
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
    toUSVString: (s: string) => s.toWellFormed?.() ?? s,
    getSystemErrorName: (n: number) => `E${-n}`,
    getSystemErrorMap: () => new Map(),
    aborted: (signal: AbortSignal) => new Promise((r) => signal.addEventListener('abort', r, { once: true })),
    transferableAbortSignal: (s: AbortSignal) => s,
    parseEnv: (content: string) => {
      if (typeof content !== 'string') throw Object.assign(new TypeError(`The "content" argument must be of type string. Received ${received(content)}`), { code: 'ERR_INVALID_ARG_TYPE' });
      return misc.parseEnv(content);
    },
    getCallSites: () => [],
    parseArgs,
    formatWithOptions: (_options: unknown, ...args: unknown[]) => (util as unknown as { format(...a: unknown[]): string }).format(...args),
    debug: (util as unknown as { debuglog: unknown }).debuglog,
  });
  nodeUtil.inspect.custom ??= Symbol.for('nodejs.util.inspect.custom');
  // util.promisify.custom is Node's registered symbol (the polyfill has one of its own, which no
  // library can name): a function's promise form under either is what promisify returns (setTimeout's,
  // fs.exists's, child_process.exec's: their callbacks are not (err, value)).
  const polyfillPromisify = util.promisify as ((fn: unknown) => unknown) & { custom?: symbol };
  nodeUtil.promisify = Object.assign(
    (original: unknown) => {
      const custom = typeof original === 'function' ? (original as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM] : undefined;
      if (custom === undefined) return polyfillPromisify(original);
      if (typeof custom !== 'function') throw Object.assign(new TypeError(`The "util.promisify.custom" property must be of type function. Received ${received(custom)}`), { code: 'ERR_INVALID_ARG_TYPE' });
      return Object.defineProperty(custom, PROMISIFY_CUSTOM, { value: custom, enumerable: false, writable: false, configurable: true });
    },
    { custom: PROMISIFY_CUSTOM },
  );

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
  const CRYPTO_KEYS_MEMBERS = ['KeyObject', 'createSecretKey', 'createPublicKey', 'createPrivateKey', 'sign', 'verify', 'createSign', 'Sign', 'createVerify', 'Verify', 'publicEncrypt', 'privateDecrypt', 'privateEncrypt', 'publicDecrypt'];
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
        return withBase64Url(lib().createHash as (a: string, o?: unknown) => { digest(enc?: string): Buffer | string })(ripemdName(alg), options);
      } catch {
        throw new Error('Digest method not supported');
      }
    };
    const createHmac = (alg: string, key: unknown, options?: unknown) => {
      const name = hashAlgorithm(alg);
      if (name) return new Hmac(name, key);
      try {
        return withBase64Url(lib().createHmac as (a: string, k: unknown, o?: unknown) => { digest(enc?: string): Buffer | string })(ripemdName(alg), key, options);
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
    // As Node's: uniform over [min, max) (48 random bits, drawn again when above the largest multiple
    // of the range: no value is likelier than another), its checks and its errors.
    const RAND_MAX = 2 ** 48 - 1;
    const randomInt = (min: number, max?: number | ((err: undefined, n: number) => void), cb?: (err: undefined, n: number) => void) => {
      const minNotSpecified = max === undefined || typeof max === 'function';
      if (minNotSpecified) [min, max, cb] = [0, min, max as typeof cb];
      const invalid = (what: string, expected: string, v: unknown) => Object.assign(new TypeError(`The "${what}" argument must be ${expected}. Received ${received(v)}`), { code: 'ERR_INVALID_ARG_TYPE' });
      const outOfRange = (what: string, range: string, v: number) => Object.assign(new RangeError(`The value of "${what}" is out of range. It must be ${range}. Received ${Number.isInteger(v) && Math.abs(v) > 2 ** 32 ? String(v).replace(/\B(?=(\d{3})+$)/g, '_') : String(v)}`), { code: 'ERR_OUT_OF_RANGE' });
      if (cb !== undefined && typeof cb !== 'function') throw invalid('callback', 'of type function', cb);
      if (!Number.isSafeInteger(min)) throw invalid('min', 'a safe integer', min);
      if (!Number.isSafeInteger(max)) throw invalid('max', 'a safe integer', max);
      const top = max as number;
      if (top <= min) throw outOfRange('max', `greater than the value of "min" (${min})`, top);
      const range = top - min;
      if (!(range <= RAND_MAX)) throw outOfRange(`max${minNotSpecified ? '' : ' - min'}`, `<= ${RAND_MAX}`, range);
      const limit = RAND_MAX - (RAND_MAX % range);
      const bytes = new Uint8Array(6);
      let x: number;
      do {
        globalThis.crypto.getRandomValues(bytes);
        x = bytes.reduce((n, b) => n * 256 + b, 0);
      } while (x >= limit);
      const n = (x % range) + min;
      if (!cb) return n;
      // As Node's: on the next tick, without an error (undefined).
      queueMicrotask(() => cb(undefined, n));
    };
    // As Node's: a null IV only for a mode without one (ECB, which browserify-aes and browserify-des
    // take as an empty IV), never an empty one for GCM (the nonce), and a secret KeyObject as the key.
    const invalidIv = () => Object.assign(new TypeError('Invalid initialization vector'), { code: 'ERR_CRYPTO_INVALID_IV' });
    const withIv = (name: 'createCipheriv' | 'createDecipheriv') =>
      function (alg: string, key: unknown, iv: unknown, options?: unknown) {
        const mode = typeof alg === 'string' ? alg.toLowerCase() : '';
        const ecb = mode.endsWith('-ecb') || mode === 'des-ede' || mode === 'des-ede3';
        if (iv !== null && typeof iv !== 'string' && !ArrayBuffer.isView(iv) && !(iv instanceof ArrayBuffer)) {
          throw Object.assign(new TypeError(`The "iv" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ${received(iv)}`), { code: 'ERR_INVALID_ARG_TYPE' });
        }
        const ivLength = iv === null ? 0 : typeof iv === 'string' ? Buffer.byteLength(iv) : iv.byteLength;
        if (ecb ? ivLength > 0 : iv === null || (mode.endsWith('-gcm') && ivLength === 0)) throw invalidIv();
        if (key instanceof keysLib().KeyObject) {
          if (key.type !== 'secret') throw Object.assign(new TypeError(`Invalid key object type ${key.type}, expected secret.`), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' });
          key = (key as unknown as { export(): Buffer }).export();
        }
        return (lib()[name] as (a: string, k: unknown, i: unknown, o?: unknown) => unknown)(alg, key, iv ?? Buffer.alloc(0), options);
      };
    const createCipheriv = withIv('createCipheriv');
    const createDecipheriv = withIv('createDecipheriv');
    // KeyObject, sign and verify (builtins/crypto-keys.ts), from the same library when first used.
    let signing: ReturnType<typeof CryptoKeys.makeSigning> | undefined;
    const keysLib = () => (lib() as unknown as Record<symbol, typeof CryptoKeys>)[Symbol.for(CRYPTO_KEYS_KEY)];
    const keys = (): Record<string, unknown> => {
      const k = keysLib();
      signing ??= k.makeSigning({ createHash: createHash as never, randomBytes: randomBytes as never });
      const withKeyObject = (name: 'publicEncrypt' | 'privateDecrypt' | 'privateEncrypt' | 'publicDecrypt') => (key: unknown, buffer: unknown) =>
        (lib()[name] as (k: unknown, b: unknown) => Buffer)(k.pemForEncryption(key, name), buffer);
      return {
        ...signing,
        KeyObject: k.KeyObject,
        createSecretKey: k.createSecretKey,
        createPublicKey: k.createPublicKey,
        createPrivateKey: k.createPrivateKey,
        publicEncrypt: withKeyObject('publicEncrypt'),
        privateDecrypt: withKeyObject('privateDecrypt'),
        privateEncrypt: withKeyObject('privateEncrypt'),
        publicDecrypt: withKeyObject('publicDecrypt'),
      };
    };
    // crypto-browserify's other members, from the library when first used (its keys, in its order:
    // a test checks them against the library).
    const crypto = Object.create(null) as Record<string, unknown>;
    for (const key of CRYPTO_LIB_KEYS) lazyMember(crypto, key, lib);
    for (const key of CRYPTO_KEYS_MEMBERS) lazyMember(crypto, key, keys);
    Object.assign(crypto, {
      createHash,
      createHmac,
      createCipheriv,
      Cipheriv: createCipheriv,
      createDecipheriv,
      Decipheriv: createDecipheriv,
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
      randomInt,
      scrypt,
      scryptSync,
      ...makeHkdf(createHmac as never),
      timingSafeEqual,
      getHashes,
      getCiphers,
      listCiphers: getCiphers,
      getCurves,
      constants: CONSTANTS,
      hash: (alg: string, data: string, enc: BufferEncoding = 'hex') => (createHash as unknown as (a: string) => { update(d: string): { digest(e: string): string } })(alg).update(data).digest(enc),
    });
    return crypto;
  };

  let cryptoMade: Record<string, unknown> | undefined;
  /** node:crypto, made once (util.types.isKeyObject asks for its KeyObject). */
  function cryptoModule() {
    return (cryptoMade ??= makeCrypto());
  }

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
      crc32: (data: Uint8Array | string, value = 0) => {
        let c = ~value;
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
    events: () => Object.assign(events, { EventEmitter, EventEmitterAsyncResource, default: events, getEventListeners: (e: EventEmitter, n: string) => e.listeners(n), addAbortListener: (s: AbortSignal, fn: () => void) => { s.addEventListener('abort', fn); return { [Symbol.dispose]: () => s.removeEventListener('abort', fn) }; } }),
    stream: () => stream,
    'stream/promises': () => stream.promises,
    // As Node's: the streams, their readers, writers and controllers (the browser's, its globals), in Node's order.
    'stream/web': () => {
      const g = globalThis as unknown as Record<string, unknown>;
      return Object.fromEntries(
        ['ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest', 'ReadableByteStreamController', 'ReadableStreamDefaultController', 'TransformStream', 'TransformStreamDefaultController', 'WritableStream', 'WritableStreamDefaultWriter', 'WritableStreamDefaultController', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream', 'DecompressionStream'].map((name) => [name, g[name]]),
      );
    },
    'stream/consumers': () => {
      const chunks = async (s: AsyncIterable<Uint8Array | string>) => {
        const parts: Uint8Array[] = [];
        for await (const c of s) parts.push(typeof c === 'string' ? Buffer.from(c) : c);
        return parts;
      };
      const text = async (s: AsyncIterable<Uint8Array | string>) => {
        let t = '';
        // One decoder for the stream: a character's bytes may come in two chunks.
        const decoder = new TextDecoder();
        for await (const c of s) t += typeof c === 'string' ? c : decoder.decode(c, { stream: true });
        return t + decoder.decode();
      };
      const buffer = async (s: AsyncIterable<Uint8Array | string>) => Buffer.concat(await chunks(s));
      return {
        text,
        buffer,
        json: async (s: AsyncIterable<Uint8Array | string>) => JSON.parse(await text(s)),
        // An ArrayBuffer of its own (a Buffer's may be a pool's, with other bytes around its own).
        arrayBuffer: async (s: AsyncIterable<Uint8Array | string>) => {
          const b = await buffer(s);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
        blob: async (s: AsyncIterable<Uint8Array | string>) => new Blob((await chunks(s)) as BlobPart[]),
      };
    },
    string_decoder: () => stringDecoder,
    util: () => nodeUtil,
    'util/types': () => nodeUtil.types,
    sys: () => nodeUtil,
    assert: () => assert,
    'assert/strict': () => assertStrict,
    url: () => Object.assign(url, { URLPattern: (globalThis as { URLPattern?: unknown }).URLPattern }),
    querystring: () => ({ ...querystring, escape: qsEscape, unescape: qsUnescape, unescapeBuffer }),
    punycode: () => punycode,
    crypto: cryptoModule,
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
    // As Node's: os.constants' dlopen, errno, priority and signals, then fs's and crypto's constants.
    constants: () => {
      const { dlopen, errno, priority, signals } = misc.os.constants;
      // As Node's: crypto.constants' defaultCipherList is among them only when node:crypto was loaded first.
      const cryptoLoaded = cryptoMade !== undefined;
      const { defaultCipherList, ...crypto } = cryptoModule().constants as Record<string, unknown>;
      return { ...dlopen, ...errno, ...priority, ...signals, ...fs.constants, ...crypto, ...(cryptoLoaded ? { defaultCipherList } : {}) };
    },
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
