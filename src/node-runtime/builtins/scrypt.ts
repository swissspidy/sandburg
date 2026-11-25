import { Buffer } from 'buffer';
import { Hmac } from './hash.ts';

/**
 * node:crypto's scrypt and scryptSync (RFC 7914), which crypto-browserify does not have: apps hash
 * passwords with them (a seeded admin user, a session secret). PBKDF2-HMAC-SHA256 with one iteration
 * around ROMix over Salsa20/8, as in Node, with its defaults (N 16384, r 8, p 1), its option aliases
 * (cost, blockSize, parallelization) and its memory limit (maxmem, 32 MiB).
 */

interface ScryptOptions {
  N?: number;
  r?: number;
  p?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  maxmem?: number;
}

const invalidArg = (msg: string) => Object.assign(new TypeError(msg), { code: 'ERR_INVALID_ARG_TYPE' });
const invalidParams = () => Object.assign(new RangeError('Invalid scrypt params: memory limit exceeded or invalid parameters'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });

function bytesOf(v: unknown, name: string): Uint8Array {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw invalidArg(`The "${name}" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
}

/** PBKDF2-HMAC-SHA256 with one iteration: T_i = HMAC(P, S || INT(i)). */
function pbkdf2Once(password: Uint8Array, salt: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  for (let i = 1, at = 0; at < length; i++, at += 32) {
    new DataView(block.buffer).setUint32(salt.length, i);
    const t = new Hmac('sha256', password).update(block).digest() as Buffer;
    out.set(t.subarray(0, Math.min(32, length - at)), at);
  }
  return out;
}

function salsa208(b: Uint32Array, x: Uint32Array) {
  x.set(b);
  for (let i = 0; i < 8; i += 2) {
    const R = (a: number, n: number) => (a << n) | (a >>> (32 - n));
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) b[i] += x[i];
}

/** BlockMix over 2r 64-byte blocks of b (32r words), into y, then back into b. */
function blockMix(b: Uint32Array, y: Uint32Array, r: number, t: Uint32Array, x: Uint32Array) {
  t.set(b.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) t[j] ^= b[i * 16 + j];
    salsa208(t, x);
    // Even blocks to the first half, odd blocks to the second.
    y.set(t, ((i & 1) * r + (i >> 1)) * 16);
  }
  b.set(y);
}

function roMix(bytes: Uint8Array, r: number, N: number) {
  const words = 32 * r;
  const b = new Uint32Array(words);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < words; i++) b[i] = view.getUint32(i * 4, true);
  const v = new Uint32Array(words * N);
  const y = new Uint32Array(words);
  const t = new Uint32Array(16);
  const x = new Uint32Array(16);
  for (let i = 0; i < N; i++) {
    v.set(b, i * words);
    blockMix(b, y, r, t, x);
  }
  for (let i = 0; i < N; i++) {
    const j = b[(2 * r - 1) * 16] & (N - 1);
    for (let k = 0; k < words; k++) b[k] ^= v[j * words + k];
    blockMix(b, y, r, t, x);
  }
  for (let i = 0; i < words; i++) view.setUint32(i * 4, b[i], true);
}

function params(keylen: unknown, options: ScryptOptions | undefined) {
  if (typeof keylen !== 'number') throw invalidArg(`The "keylen" argument must be of type number. Received type ${typeof keylen} (${String(keylen)})`);
  if (!Number.isInteger(keylen) || keylen < 0 || keylen > 2 ** 31 - 1) {
    throw Object.assign(new RangeError(`The value of "keylen" is out of range. It must be >= 0 && <= ${2 ** 31 - 1}. Received ${keylen}`), { code: 'ERR_OUT_OF_RANGE' });
  }
  const o = options ?? {};
  const pick = (a: number | undefined, b: number | undefined, fallback: number) => {
    if (a !== undefined && b !== undefined) throw Object.assign(new Error('Invalid scrypt parameter'), { code: 'ERR_CRYPTO_SCRYPT_INVALID_PARAMETER' });
    return a ?? b ?? fallback;
  };
  const N = pick(o.N, o.cost, 16384);
  const r = pick(o.r, o.blockSize, 8);
  const p = pick(o.p, o.parallelization, 1);
  const maxmem = o.maxmem ?? 32 << 20;
  for (const v of [N, r, p, maxmem]) if (!Number.isSafeInteger(v) || v < 0) throw invalidParams();
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1 || p * r > 2 ** 30 - 1 || 128 * N * r > maxmem) throw invalidParams();
  return { N, r, p };
}

export function scryptSync(password: unknown, salt: unknown, keylen: number, options?: ScryptOptions): Buffer {
  const { N, r, p } = params(keylen, options);
  const pw = bytesOf(password, 'password');
  const b = pbkdf2Once(pw, bytesOf(salt, 'salt'), p * 128 * r);
  for (let i = 0; i < p; i++) roMix(b.subarray(i * 128 * r, (i + 1) * 128 * r), r, N);
  const key = pbkdf2Once(pw, b, keylen);
  return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
}

export function scrypt(password: unknown, salt: unknown, keylen: number, ...rest: unknown[]) {
  const cb = rest.pop();
  if (typeof cb !== 'function') throw invalidArg('The "callback" argument must be of type function.');
  const key = scryptSync(password, salt, keylen, rest[0] as ScryptOptions | undefined);
  queueMicrotask(() => (cb as (e: Error | null, k?: Buffer) => void)(null, key));
}
