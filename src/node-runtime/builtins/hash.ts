import { Buffer } from 'buffer';
import { Transform } from 'readable-stream';

/**
 * node:crypto's common hashes (MD5, SHA-1 and SHA-2) in the runtime's script, so that a program that
 * only hashes does not load crypto-browserify (a 1.2 MB runtime library, ADR 0028), and hashes faster
 * than its sha.js and md5.js: blocks are read from the input in place, not copied into a Buffer and
 * read back with readInt32BE. Vite hashes every response it serves (its ETag is a SHA-1) and its
 * lockfile; webpack, Next.js and many tools hash file contents and ids.
 *
 * Each algorithm is a block function over 32-bit words; SHA-384 and SHA-512 keep each 64-bit word as
 * two 32-bit halves, as sha.js does.
 */

/** One algorithm: its block size in bytes, its initial state, its block function and how long a digest is. */
interface Algorithm {
  block: 64 | 128;
  init: readonly number[];
  digestBytes: number;
  littleEndian: boolean;
  compress(state: Int32Array, w: Int32Array, bytes: Uint8Array, at: number): void;
}

const K256 = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const be32 = (b: Uint8Array, i: number) => (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];

function sha1(s: Int32Array, w: Int32Array, b: Uint8Array, at: number): void {
  for (let i = 0; i < 16; i++) w[i] = be32(b, at + i * 4);
  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (x << 1) | (x >>> 31);
  }
  let a = s[0], bb = s[1], c = s[2], d = s[3], e = s[4];
  for (let i = 0; i < 80; i++) {
    let f: number, k: number;
    if (i < 20) {
      f = (bb & c) | (~bb & d);
      k = 0x5a827999;
    } else if (i < 40) {
      f = bb ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (i < 60) {
      f = (bb & c) | (bb & d) | (c & d);
      k = 0x8f1bbcdc | 0;
    } else {
      f = bb ^ c ^ d;
      k = 0xca62c1d6 | 0;
    }
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
    e = d;
    d = c;
    c = (bb << 30) | (bb >>> 2);
    bb = a;
    a = t;
  }
  s[0] = (s[0] + a) | 0;
  s[1] = (s[1] + bb) | 0;
  s[2] = (s[2] + c) | 0;
  s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0;
}

function sha256(s: Int32Array, w: Int32Array, b: Uint8Array, at: number): void {
  for (let i = 0; i < 16; i++) w[i] = be32(b, at + i * 4);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = s[0], bb = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = bb;
    bb = a;
    a = (t1 + t2) | 0;
  }
  s[0] = (s[0] + a) | 0;
  s[1] = (s[1] + bb) | 0;
  s[2] = (s[2] + c) | 0;
  s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0;
  s[5] = (s[5] + f) | 0;
  s[6] = (s[6] + g) | 0;
  s[7] = (s[7] + h) | 0;
}

/** SHA-512's round constants, as high and low halves. */
const K512 = Int32Array.from([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b,
  0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1,
  0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275,
  0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
  0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001,
  0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8,
  0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915,
  0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6,
  0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

/** The carry of a 32-bit addition of `sum`'s low half, `a` the low half it was made of. */
const carry = (sum: number, a: number) => ((sum >>> 0) < (a >>> 0) ? 1 : 0);

function sha512(s: Int32Array, w: Int32Array, b: Uint8Array, at: number): void {
  for (let i = 0; i < 32; i++) w[i] = be32(b, at + i * 4);
  for (let i = 32; i < 160; i += 2) {
    let xh = w[i - 30], xl = w[i - 29];
    // σ0: rotr 1 ^ rotr 8 ^ shr 7
    const g0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const g0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    xh = w[i - 4];
    xl = w[i - 3];
    // σ1: rotr 19 ^ rotr 61 ^ shr 6
    const g1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
    const g1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
    // w[i] = σ1 + w[i-7] + σ0 + w[i-16]
    let l = (g0l + w[i - 13]) | 0;
    let h = (g0h + w[i - 14] + carry(l, g0l)) | 0;
    const l2 = (l + g1l) | 0;
    h = (h + g1h + carry(l2, l)) | 0;
    l = (l2 + w[i - 31]) | 0;
    h = (h + w[i - 32] + carry(l, l2)) | 0;
    w[i] = h;
    w[i + 1] = l;
  }
  let ah = s[0], al = s[1], bh = s[2], bl = s[3], ch = s[4], cl = s[5], dh = s[6], dl = s[7];
  let eh = s[8], el = s[9], fh = s[10], fl = s[11], gh = s[12], gl = s[13], hh = s[14], hl = s[15];
  for (let j = 0; j < 160; j += 2) {
    const majh = (ah & bh) | (ch & (ah | bh));
    const majl = (al & bl) | (cl & (al | bl));
    // Σ0: rotr 28 ^ rotr 34 ^ rotr 39
    const s0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const s0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    // Σ1: rotr 14 ^ rotr 18 ^ rotr 41
    const s1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const s1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = gh ^ (eh & (fh ^ gh));
    const chl = gl ^ (el & (fl ^ gl));
    // t1 = h + Σ1 + ch + K[j] + w[j]
    let t1l = (hl + s1l) | 0;
    let t1h = (hh + s1h + carry(t1l, hl)) | 0;
    let x = (t1l + chl) | 0;
    t1h = (t1h + chh + carry(x, t1l)) | 0;
    t1l = (x + K512[j + 1]) | 0;
    t1h = (t1h + K512[j] + carry(t1l, x)) | 0;
    x = (t1l + w[j + 1]) | 0;
    t1h = (t1h + w[j] + carry(x, t1l)) | 0;
    t1l = x;
    // t2 = Σ0 + maj
    const t2l = (s0l + majl) | 0;
    const t2h = (s0h + majh + carry(t2l, s0l)) | 0;
    hh = gh;
    hl = gl;
    gh = fh;
    gl = fl;
    fh = eh;
    fl = el;
    el = (dl + t1l) | 0;
    eh = (dh + t1h + carry(el, dl)) | 0;
    dh = ch;
    dl = cl;
    ch = bh;
    cl = bl;
    bh = ah;
    bl = al;
    al = (t1l + t2l) | 0;
    ah = (t1h + t2h + carry(al, t1l)) | 0;
  }
  const add = (i: number, h: number, l: number) => {
    const sl = (s[i + 1] + l) | 0;
    s[i] = (s[i] + h + carry(sl, l)) | 0;
    s[i + 1] = sl;
  };
  add(0, ah, al);
  add(2, bh, bl);
  add(4, ch, cl);
  add(6, dh, dl);
  add(8, eh, el);
  add(10, fh, fl);
  add(12, gh, gl);
  add(14, hh, hl);
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

function md5(s: Int32Array, w: Int32Array, b: Uint8Array, at: number): void {
  for (let i = 0; i < 16; i++) {
    const j = at + i * 4;
    w[i] = b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24);
  }
  let a = s[0], bb = s[1], c = s[2], d = s[3];
  for (let i = 0; i < 64; i++) {
    let f: number, g: number;
    if (i < 16) {
      f = (bb & c) | (~bb & d);
      g = i;
    } else if (i < 32) {
      f = (d & bb) | (~d & c);
      g = (5 * i + 1) & 15;
    } else if (i < 48) {
      f = bb ^ c ^ d;
      g = (3 * i + 5) & 15;
    } else {
      f = c ^ (bb | ~d);
      g = (7 * i) & 15;
    }
    const r = MD5_S[((i >>> 4) << 2) | (i & 3)];
    const x = (a + f + MD5_K[i] + w[g]) | 0;
    a = d;
    d = c;
    c = bb;
    bb = (bb + ((x << r) | (x >>> (32 - r)))) | 0;
  }
  s[0] = (s[0] + a) | 0;
  s[1] = (s[1] + bb) | 0;
  s[2] = (s[2] + c) | 0;
  s[3] = (s[3] + d) | 0;
}

const ALGORITHMS: Record<string, Algorithm> = {
  md5: { block: 64, digestBytes: 16, littleEndian: true, compress: md5, init: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476] },
  sha1: { block: 64, digestBytes: 20, littleEndian: false, compress: sha1, init: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0] },
  sha224: { block: 64, digestBytes: 28, littleEndian: false, compress: sha256, init: [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4] },
  sha256: { block: 64, digestBytes: 32, littleEndian: false, compress: sha256, init: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] },
  sha384: {
    block: 128,
    digestBytes: 48,
    littleEndian: false,
    compress: sha512,
    init: [
      0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d,
      0xbefa4fa4,
    ],
  },
  sha512: {
    block: 128,
    digestBytes: 64,
    littleEndian: false,
    compress: sha512,
    init: [
      0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19,
      0x137e2179,
    ],
  },
};
// The names Node (OpenSSL) also knows these by.
const ALIASES: Record<string, string> = { 'sha-1': 'sha1', 'sha-224': 'sha224', 'sha-256': 'sha256', 'sha-384': 'sha384', 'sha-512': 'sha512', 'rsa-md5': 'md5', 'rsa-sha1': 'sha1', 'rsa-sha256': 'sha256', 'rsa-sha384': 'sha384', 'rsa-sha512': 'sha512', 'rsa-sha224': 'sha224' };

/** The algorithm a name stands for, if it is one of these (names are case-insensitive, as in Node). */
export function hashAlgorithm(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.toLowerCase();
  return n in ALGORITHMS ? n : (ALIASES[n] ?? null);
}

/** A hash's running state: update() with bytes, then digest() once. */
export class HashState {
  private readonly alg: Algorithm;
  private readonly state: Int32Array;
  private readonly w: Int32Array;
  private readonly pending: Uint8Array;
  private pendingLength = 0;
  private length = 0;

  constructor(name: string, from?: HashState) {
    this.alg = ALGORITHMS[name];
    this.state = from ? from.state.slice() : Int32Array.from(this.alg.init);
    this.w = new Int32Array(this.alg.block === 64 ? 80 : 160);
    this.pending = from ? from.pending.slice() : new Uint8Array(this.alg.block);
    if (from) {
      this.pendingLength = from.pendingLength;
      this.length = from.length;
    }
  }

  copy(name: string): HashState {
    return new HashState(name, this);
  }

  update(bytes: Uint8Array): void {
    const { block, compress } = this.alg;
    this.length += bytes.length;
    let at = 0;
    if (this.pendingLength) {
      const take = Math.min(block - this.pendingLength, bytes.length);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      at = take;
      if (this.pendingLength < block) return;
      compress(this.state, this.w, this.pending, 0);
      this.pendingLength = 0;
    }
    for (; at + block <= bytes.length; at += block) compress(this.state, this.w, bytes, at);
    if (at < bytes.length) {
      this.pending.set(bytes.subarray(at), 0);
      this.pendingLength = bytes.length - at;
    }
  }

  digest(): Uint8Array {
    const { block, compress, digestBytes, littleEndian } = this.alg;
    const lengthBytes = block === 64 ? 8 : 16;
    const tail = new Uint8Array(this.pendingLength + 1 + lengthBytes <= block ? block : block * 2);
    tail.set(this.pending.subarray(0, this.pendingLength));
    tail[this.pendingLength] = 0x80;
    // The length in bits, a 64-bit (SHA-512: 128-bit) number at the end.
    const bits = this.length * 8;
    const hi = Math.floor(bits / 2 ** 32);
    const lo = bits >>> 0;
    const view = new DataView(tail.buffer);
    if (littleEndian) {
      view.setUint32(tail.length - 8, lo, true);
      view.setUint32(tail.length - 4, hi, true);
    } else {
      view.setUint32(tail.length - 8, hi);
      view.setUint32(tail.length - 4, lo);
    }
    for (let at = 0; at < tail.length; at += block) compress(this.state, this.w, tail, at);
    const out = new Uint8Array(digestBytes);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < digestBytes / 4; i++) outView.setInt32(i * 4, this.state[i], littleEndian);
    return out;
  }
}

type Encoding = BufferEncoding | 'buffer';
const finalized = () => Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });

function toBytes(data: unknown, enc: unknown, name: string): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, (typeof enc === 'string' && enc !== 'buffer' ? enc : 'utf8') as BufferEncoding);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw Object.assign(new TypeError(`The "${name}" argument must be of type string or an instance of Buffer, TypedArray, or DataView.${describe(data)}`), { code: 'ERR_INVALID_ARG_TYPE' });
}
const describe = (v: unknown) => (v === null || v === undefined ? ` Received ${v}` : typeof v === 'object' ? ` Received an instance of ${(v).constructor?.name ?? 'Object'}` : ` Received type ${typeof v} (${String(v)})`);
const encode = (bytes: Uint8Array, enc: unknown): Buffer | string => {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // An encoding Node does not know gives a Buffer, as in Node.
  return typeof enc === 'string' && Buffer.isEncoding(enc) ? buf.toString(enc) : buf;
};

/** node:crypto's Hash: update() and digest(), and a Transform stream of its input to its digest, as in Node. */
export class Hash extends Transform {
  private h: HashState | null;
  private readonly alg: string;
  constructor(alg: string, from?: HashState) {
    super();
    this.alg = alg;
    this.h = from ? from.copy(alg) : new HashState(alg);
  }
  update(data: unknown, inputEncoding?: Encoding): this {
    if (!this.h) throw finalized();
    this.h.update(toBytes(data, inputEncoding, 'data'));
    return this;
  }
  digest(outputEncoding?: Encoding): Buffer | string {
    if (!this.h) throw finalized();
    const out = this.h.digest();
    this.h = null;
    return encode(out, outputEncoding);
  }
  copy(): Hash {
    if (!this.h) throw finalized();
    return new Hash(this.alg, this.h);
  }
  _transform(chunk: unknown, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      this.update(chunk, enc);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
  _flush(cb: (e?: Error | null) => void) {
    this.push(this.digest());
    cb();
  }
}

/** node:crypto's Hmac over one of these hashes (RFC 2104). */
export class Hmac extends Transform {
  private inner: HashState | null;
  private readonly outerKey: Uint8Array;
  private readonly alg: string;
  constructor(alg: string, key: unknown) {
    super();
    this.alg = alg;
    const block = ALGORITHMS[alg].block;
    let k = keyBytes(key);
    if (k.length > block) {
      const h = new HashState(alg);
      h.update(k);
      k = h.digest();
    }
    const ipad = new Uint8Array(block).fill(0x36);
    this.outerKey = new Uint8Array(block).fill(0x5c);
    for (let i = 0; i < k.length; i++) {
      ipad[i] ^= k[i];
      this.outerKey[i] ^= k[i];
    }
    this.inner = new HashState(alg);
    this.inner.update(ipad);
  }
  update(data: unknown, inputEncoding?: Encoding): this {
    if (!this.inner) throw finalized();
    this.inner.update(toBytes(data, inputEncoding, 'data'));
    return this;
  }
  digest(outputEncoding?: Encoding): Buffer | string {
    // Node returns an empty digest from a second call of an Hmac's digest().
    if (!this.inner) return encode(new Uint8Array(0), outputEncoding);
    const outer = new HashState(this.alg);
    outer.update(this.outerKey);
    outer.update(this.inner.digest());
    this.inner = null;
    return encode(outer.digest(), outputEncoding);
  }
  _transform(chunk: unknown, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      this.update(chunk, enc);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
  _flush(cb: (e?: Error | null) => void) {
    this.push(this.digest());
    cb();
  }
}

/** An HMAC key: a string (UTF-8), bytes (a view or an ArrayBuffer), or a secret KeyObject (its export()). */
function keyBytes(key: unknown): Uint8Array {
  if (key && typeof key === 'object' && typeof (key as { export?: unknown }).export === 'function' && (key as { type?: unknown }).type === 'secret') {
    return toBytes((key as { export(): unknown }).export(), undefined, 'key');
  }
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  return toBytes(key, undefined, 'key');
}
