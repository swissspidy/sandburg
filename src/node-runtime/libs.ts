/**
 * Polyfills of built-ins that few runtimes load, left out of the runtime's script: each is a script
 * of its own (/__sandburg/node-<name>.js), which a runtime loads with importScripts the first time a
 * program requires the built-in (runtimeLib in worker.ts). Every runtime compiles its whole script
 * (a worker's script gets no code cache), and every thread and spare is a runtime: these were 1.9
 * of its 2.8 MB, and node:crypto's and node:zlib's were evaluated in each.
 */
export const RUNTIME_LIBS = { crypto: 'crypto-browserify', hash: 'create-hash', zlib: 'browserify-zlib', wasi: '@napi-rs/wasm-runtime' } as const;
/**
 * crypto-browserify's exports (its index.js). node:crypto has them all, but loads the library (1.2 MB:
 * ciphers, signatures, elliptic curves) only when a program uses one beyond the hashes and random
 * bytes that most use, which come from the `hash` library (140 KB).
 */
export const CRYPTO_EXPORTS = [
  'prng', 'pseudoRandomBytes', 'rng', 'randomBytes', 'Hash', 'createHash', 'Hmac', 'createHmac', 'getHashes', 'pbkdf2', 'pbkdf2Sync',
  'Cipher', 'createCipher', 'Cipheriv', 'createCipheriv', 'Decipher', 'createDecipher', 'Decipheriv', 'createDecipheriv', 'getCiphers', 'listCiphers',
  'DiffieHellmanGroup', 'createDiffieHellmanGroup', 'getDiffieHellman', 'createDiffieHellman', 'DiffieHellman',
  'createSign', 'Sign', 'createVerify', 'Verify', 'createECDH', 'publicEncrypt', 'privateEncrypt', 'publicDecrypt', 'privateDecrypt',
  'randomFill', 'randomFillSync', 'createCredentials', 'constants',
] as const;
export type RuntimeLib = keyof typeof RUNTIME_LIBS;
/** Where a loaded library puts its exports, and where the runtime's script keeps its CommonJS modules by path. */
export const LIBS_KEY = 'sandburg.libs';
export const MODULES_KEY = 'sandburg.modules';
