/**
 * Polyfills of built-ins that few runtimes load, left out of the runtime's script: each is a script
 * of its own (/__sandburg/node-<name>.js), which a runtime loads with importScripts the first time a
 * program requires the built-in (runtimeLib in worker.ts). Every runtime compiles its whole script
 * (a worker's script gets no code cache), and every thread and spare is a runtime: these were 1.9
 * of its 2.8 MB, and node:crypto's and node:zlib's were evaluated in each.
 */
export const RUNTIME_LIBS = { crypto: 'crypto-browserify', zlib: 'browserify-zlib', wasi: '@napi-rs/wasm-runtime' } as const;
export type RuntimeLib = keyof typeof RUNTIME_LIBS;
/** Where a loaded library puts its exports, and where the runtime's script keeps its CommonJS modules by path. */
export const LIBS_KEY = 'sandburg.libs';
export const MODULES_KEY = 'sandburg.modules';

/** crypto-browserify's exports (node:crypto takes what it does not have itself from there). */
export const CRYPTO_LIB_KEYS = [
  'prng', 'pseudoRandomBytes', 'rng', 'randomBytes', 'Hash', 'createHash', 'Hmac', 'createHmac', 'getHashes', 'pbkdf2', 'pbkdf2Sync', 'Cipher', 'createCipher', 'Cipheriv',
  'createCipheriv', 'Decipher', 'createDecipher', 'Decipheriv', 'createDecipheriv', 'getCiphers', 'listCiphers', 'DiffieHellmanGroup', 'createDiffieHellmanGroup', 'getDiffieHellman',
  'createDiffieHellman', 'DiffieHellman', 'createSign', 'Sign', 'createVerify', 'Verify', 'createECDH', 'publicEncrypt', 'privateEncrypt', 'publicDecrypt', 'privateDecrypt', 'randomFill',
  'randomFillSync', 'createCredentials', 'constants',
];

/** browserify-zlib's exports other than its Z_* constants (ZLIB_CONSTANTS), which node:zlib takes from there. */
export const ZLIB_LIB_KEYS = [
  'Zlib', 'codes', 'Deflate', 'Inflate', 'Gzip', 'Gunzip', 'DeflateRaw', 'InflateRaw', 'Unzip', 'createDeflate', 'createInflate', 'createDeflateRaw', 'createInflateRaw', 'createGzip',
  'createGunzip', 'createUnzip', 'deflate', 'deflateSync', 'gzip', 'gzipSync', 'deflateRaw', 'deflateRawSync', 'unzip', 'unzipSync', 'inflate', 'inflateSync', 'gunzip', 'gunzipSync',
  'inflateRaw', 'inflateRawSync',
];
/** zlib.h's constants, as browserify-zlib has them (test/unit/runtime-libs.test.ts checks them against the library). */
export const ZLIB_CONSTANTS: Record<string, number> = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1,
  Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_UNKNOWN: 2, Z_DEFLATED: 8, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
};
