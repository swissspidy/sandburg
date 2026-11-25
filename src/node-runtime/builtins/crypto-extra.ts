import { Buffer } from 'buffer';
import { received } from './process.ts';

/**
 * node:crypto members crypto-browserify does not have, or has differently from Node: HKDF (RFC 5869,
 * Auth.js derives its session keys with it), timingSafeEqual with Node's checks, and the lists and
 * constants a library reads to see what it may use: the ciphers, hashes and curves that work here.
 */

type CreateHmac = (alg: string, key: Uint8Array) => { update(d: Uint8Array): unknown; digest(): Buffer };

const argType = (name: string, expected: string, v: unknown) =>
  Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${received(v)}`), { code: 'ERR_INVALID_ARG_TYPE' });

/** A view's or an ArrayBuffer's bytes, or null. */
function viewBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) return new Uint8Array(v);
  return null;
}

function hkdfBytes(v: unknown, name: string, secretKey = false): Uint8Array {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  const bytes = viewBytes(v);
  if (bytes) return bytes;
  if (secretKey && v && typeof v === 'object' && (v as { type?: unknown }).type === 'secret' && typeof (v as { export?: unknown }).export === 'function') {
    return viewBytes((v as { export(): unknown }).export()) ?? new Uint8Array(0);
  }
  const expected = secretKey
    ? 'of type string or an instance of SecretKeyObject, ArrayBuffer, TypedArray, DataView, or Buffer'
    : 'of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView';
  throw argType(name, expected, v);
}

export function makeHkdf(createHmac: CreateHmac) {
  const hkdfSync = (digest: unknown, ikm: unknown, salt: unknown, info: unknown, keylen: unknown): ArrayBuffer => {
    if (typeof digest !== 'string') throw argType('digest', 'of type string', digest);
    const key = hkdfBytes(ikm, 'ikm', true);
    const saltBytes = hkdfBytes(salt, 'salt');
    const infoBytes = hkdfBytes(info, 'info');
    if (typeof keylen !== 'number') throw argType('length', 'of type number', keylen);
    if (!Number.isInteger(keylen) || keylen < 0 || keylen > 2 ** 31 - 1) {
      throw Object.assign(new RangeError(`The value of "length" is out of range. It must be an integer >= 0 && <= ${2 ** 31 - 1}. Received ${keylen}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    if (infoBytes.length > 1024) {
      throw Object.assign(new RangeError(`The value of "info" is out of range. It must be must not contain more than 1024 bytes. Received ${infoBytes.length}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    // Extract: PRK = HMAC(salt, IKM); an empty salt is the hash's length of zeros, which HMAC pads to the same key.
    const extract = createHmac(digest, saltBytes);
    extract.update(key);
    const prkBytes = extract.digest();
    if (keylen > 255 * prkBytes.length) throw Object.assign(new RangeError('Invalid key length'), { code: 'ERR_CRYPTO_INVALID_KEYLEN' });
    // Expand: T(i) = HMAC(PRK, T(i-1) || info || i).
    const out = new Uint8Array(keylen);
    let previous = new Uint8Array(0);
    for (let i = 1, at = 0; at < keylen; i++, at += prkBytes.length) {
      const h = createHmac(digest, prkBytes);
      h.update(previous);
      h.update(infoBytes);
      h.update(Uint8Array.of(i));
      previous = new Uint8Array(h.digest());
      out.set(previous.subarray(0, Math.min(previous.length, keylen - at)), at);
    }
    return out.buffer;
  };
  const hkdf = (digest: unknown, ikm: unknown, salt: unknown, info: unknown, keylen: unknown, cb: unknown) => {
    if (typeof cb !== 'function') throw argType('callback', 'of type function', cb);
    const key = hkdfSync(digest, ikm, salt, info, keylen);
    queueMicrotask(() => (cb as (err: null, key: ArrayBuffer) => void)(null, key));
  };
  return { hkdf, hkdfSync };
}

/** As Node's: both arguments bytes of the same length, else an error rather than false. */
export function timingSafeEqual(a: unknown, b: unknown): boolean {
  const x = viewBytes(a);
  const y = viewBytes(b);
  if (!x) throw Object.assign(new TypeError('The "buf1" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (!y) throw Object.assign(new TypeError('The "buf2" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.'), { code: 'ERR_INVALID_ARG_TYPE' });
  if (x.length !== y.length) throw Object.assign(new RangeError('Input buffers must have the same byte length'), { code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' });
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The ciphers createCipheriv has here (browserify-cipher's DES and AES modes), sorted as Node's list is. */
const CIPHERS = [
  'aes-128-cbc', 'aes-128-cfb', 'aes-128-cfb1', 'aes-128-cfb8', 'aes-128-ctr', 'aes-128-ecb', 'aes-128-gcm', 'aes-128-ofb', 'aes-192-cbc', 'aes-192-cfb', 'aes-192-cfb1',
  'aes-192-cfb8', 'aes-192-ctr', 'aes-192-ecb', 'aes-192-gcm', 'aes-192-ofb', 'aes-256-cbc', 'aes-256-cfb', 'aes-256-cfb1', 'aes-256-cfb8', 'aes-256-ctr', 'aes-256-ecb',
  'aes-256-gcm', 'aes-256-ofb', 'aes128', 'aes192', 'aes256', 'des', 'des-cbc', 'des-ecb', 'des-ede', 'des-ede-cbc', 'des-ede3', 'des-ede3-cbc', 'des3',
];
/** The digests createHash takes here (its own and create-hash's) and the signature algorithms createSign takes (browserify-sign's), sorted as Node's list is. */
const HASHES = [
  'DSA', 'DSA-RIPEMD160', 'DSA-SHA', 'DSA-SHA1', 'DSA-SHA224', 'DSA-SHA256', 'DSA-SHA384', 'DSA-SHA512', 'DSA-WITH-SHA224', 'DSA-WITH-SHA256', 'DSA-WITH-SHA384', 'DSA-WITH-SHA512',
  'RSA-MD5', 'RSA-RIPEMD160', 'RSA-SHA1', 'RSA-SHA224', 'RSA-SHA256', 'RSA-SHA384', 'RSA-SHA512', 'ecdsa-with-SHA1', 'md5', 'md5WithRSAEncryption', 'ripemd160', 'ripemd160WithRSA',
  'rmd160', 'sha1', 'sha224', 'sha224WithRSAEncryption', 'sha256', 'sha256WithRSAEncryption', 'sha384', 'sha384WithRSAEncryption', 'sha512', 'sha512WithRSAEncryption',
];
/** The curves createECDH takes here (create-ecdh's), by their OpenSSL names as Node lists them. */
const CURVES = ['prime192v1', 'prime256v1', 'secp224r1', 'secp256k1', 'secp384r1', 'secp521r1'];

export const getCiphers = () => [...CIPHERS];
export const getHashes = () => [...HASHES];
export const getCurves = () => [...CURVES];

const CIPHER_LIST =
  'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';

/** Node's crypto.constants (Node 22 with OpenSSL 3), on a null prototype as there: padding modes publicEncrypt takes, point conversions, DH checks, TLS options. */
export const CONSTANTS: Record<string, number | string> = Object.assign(Object.create(null) as Record<string, number | string>, {
  OPENSSL_VERSION_NUMBER: 810549392, SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024, SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144,
  SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304, SSL_OP_CISCO_ANYCONNECT: 32768, SSL_OP_COOKIE_EXCHANGE: 8192, SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048, SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072, SSL_OP_NO_ENCRYPT_THEN_MAC: 524288, SSL_OP_NO_QUERY_MTU: 4096,
  SSL_OP_NO_RENEGOTIATION: 1073741824, SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536, SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 33554432, SSL_OP_NO_TICKET: 16384,
  SSL_OP_NO_TLSv1: 67108864, SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_NO_TLSv1_2: 134217728, SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152,
  SSL_OP_TLS_ROLLBACK_BUG: 8388608, ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4, ENGINE_METHOD_RAND: 8, ENGINE_METHOD_EC: 2048, ENGINE_METHOD_CIPHERS: 64,
  ENGINE_METHOD_DIGESTS: 128, ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024, ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0, DH_CHECK_P_NOT_SAFE_PRIME: 2,
  DH_CHECK_P_NOT_PRIME: 1, DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8, RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2, RSA_PSS_SALTLEN_AUTO: -2, defaultCoreCipherList: CIPHER_LIST, TLS1_VERSION: 769,
  TLS1_1_VERSION: 770, TLS1_2_VERSION: 771, TLS1_3_VERSION: 772, POINT_CONVERSION_COMPRESSED: 2, POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_HYBRID: 6,
  defaultCipherList: CIPHER_LIST,
});
