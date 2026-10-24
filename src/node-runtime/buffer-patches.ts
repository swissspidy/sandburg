/**
 * The buffer polyfill's patches: what Node's Buffer does that the polyfill does not, or does slowly.
 * worker.ts applies them before any program runs.
 */
import { Buffer } from 'buffer';
import ShaHash from 'sha.js/hash.js';

/** The buffer polyfill predates the base64url encoding (Node 15+); hashes and ids use it. */
export function patchBase64Url(): void {
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
  };
  B.isEncoding = (e: string) => isUrl(e) || isEncoding(e);
  B.byteLength = (v: unknown, enc?: string) => (typeof v === 'string' && isUrl(enc) ? byteLength(toB64(v), 'base64') : byteLength(v, enc));
}

/**
 * UTF-8 through the browser's TextEncoder/TextDecoder: the buffer polyfill converts in JavaScript
 * loops, ~13x slower than Node (11 MB: 560 ms instead of 40). Tools convert a lot (webpack's cache,
 * loaders, source maps).
 */
export function patchUtf8(): void {
  const B = Buffer as unknown as {
    prototype: Record<string, (...a: unknown[]) => unknown> & { length: number; subarray(s: number, e: number): Uint8Array };
    from(v: unknown, enc?: unknown, len?: unknown): Buffer;
    byteLength(v: unknown, enc?: unknown): number;
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
    if (typeof str === 'string' && str.length > SHORT && offset >= 0 && offset <= this.length && isUtf16(enc)) return utf16Into(this, str, offset, Math.min(length, this.length - offset));
    if (typeof str !== 'string' || str.length <= SHORT || !isUtf8(enc)) return write.call(this, str, a, b, c);
    return encodeInto(this, str, offset, Math.min(length, this.length - offset));
  };
  // UTF-16: the polyfill builds an array of the string's bytes first. es-module-lexer (Vite) writes
  // each module's source this way (55 ms of a warm Vite run). Whole code units only, as Node writes them.
  const isUtf16 = (enc: unknown) => typeof enc === 'string' && /^(ucs-?2|utf-?16le)$/i.test(enc);
  const utf16Into = (buf: Uint8Array, str: string, offset: number, length: number) => {
    const units = Math.min(str.length, Math.floor(length / 2));
    for (let i = 0, at = offset; i < units; i++, at += 2) {
      const c = str.charCodeAt(i);
      buf[at] = c & 0xff;
      buf[at + 1] = c >>> 8;
    }
    return units * 2;
  };
  // The polyfill counts a string's UTF-8 bytes by encoding it into an array (vite's etag: 33 ms of a warm run).
  const { byteLength } = B;
  B.byteLength = (v: unknown, enc?: unknown) => (typeof v === 'string' && v.length > SHORT && isUtf8(enc) ? utf8Length(v) : byteLength(v, enc));
  B.prototype.utf8Write = function (this: Uint8Array, str: unknown, offset?: unknown, length?: unknown) {
    const o = typeof offset === 'number' ? offset : 0;
    return encodeInto(this, String(str), o, typeof length === 'number' ? length : this.length - o);
  };
  // Node's other undocumented per-encoding methods, which packages call directly (busboy, under Next.js'
  // server actions, decodes form fields with buf.latin1Slice): the same as toString() and write().
  for (const enc of ['latin1', 'ascii', 'hex', 'base64', 'ucs2']) {
    B.prototype[`${enc}Slice`] ??= function (this: Uint8Array, start?: unknown, end?: unknown) {
      return Reflect.apply(toString, this, [enc, typeof start === 'number' ? start : 0, typeof end === 'number' ? end : this.length]);
    };
    B.prototype[`${enc}Write`] ??= function (this: Uint8Array, str: unknown, offset?: unknown, length?: unknown) {
      const o = typeof offset === 'number' ? offset : 0;
      return Reflect.apply(write, this, [String(str), o, typeof length === 'number' ? length : this.length - o, enc]);
    };
  }
}

/**
 * crypto's SHA hashes (sha.js, under crypto-browserify) copy the input into each 64-byte block one
 * byte at a time: 38 ms of a warm Vite run, which hashes the lockfile (sha256) and every response
 * (an etag, sha1). The same copy with Uint8Array.prototype.set.
 */
export function patchHashCopy(): void {
  const { update } = ShaHash.prototype;
  type Self = { _block: Uint8Array; _blockSize: number; _len: number; _update(block: Uint8Array): void };
  ShaHash.prototype.update = function (this: Self, data: unknown, enc?: string) {
    const bytes = typeof data === 'string' ? Buffer.from(data, (enc || 'utf8') as BufferEncoding) : data;
    if (!(bytes instanceof Uint8Array)) return update.call(this, data, enc);
    const block = this._block;
    const size = this._blockSize;
    let accum = this._len;
    for (let offset = 0; offset < bytes.length; ) {
      const assigned = accum % size;
      const take = Math.min(bytes.length - offset, size - assigned);
      block.set(bytes.subarray(offset, offset + take), assigned);
      accum += take;
      offset += take;
      if (accum % size === 0) this._update(block);
    }
    this._len += bytes.length;
    return this;
  };
}

/** The length of a string's UTF-8 (a lone surrogate is U+FFFD, three bytes, as Node encodes it). */
function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 2;
      i++;
    } else n += 2;
  }
  return n;
}

/**
 * Base64 through the browser's Uint8Array.prototype.toBase64 where there is one: the buffer
 * polyfill encodes in a JavaScript loop, ~19x slower (4 MB: 127 ms instead of 7), and webpack and
 * Next.js encode source maps and hashes in base64 (~0.2 s of next dev's start). The output is the
 * same: padded base64, and base64url without padding, as Node writes them.
 */
export function patchBase64(): void {
  const native = (Uint8Array.prototype as unknown as { toBase64?: (o?: object) => string }).toBase64;
  if (typeof native !== 'function') return;
  const B = Buffer as unknown as { prototype: { toString(this: Uint8Array, enc?: unknown, start?: unknown, end?: unknown): string } };
  const { toString } = B.prototype;
  const URL_SAFE = { alphabet: 'base64url', omitPadding: true };
  B.prototype.toString = function (this: Uint8Array, enc?: unknown, start?: unknown, end?: unknown) {
    const name = typeof enc === 'string' && this.length > 64 ? enc.toLowerCase() : '';
    if (name !== 'base64' && name !== 'base64url') return toString.call(this, enc, start, end);
    const s = typeof start === 'number' && start > 0 ? Math.floor(start) : 0;
    const e = typeof end === 'number' && end < this.length ? Math.floor(end) : this.length;
    return e <= s ? '' : native.call(this.subarray(s, e), name === 'base64url' ? URL_SAFE : undefined);
  };
}
