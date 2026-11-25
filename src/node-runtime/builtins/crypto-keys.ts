import { Buffer } from 'buffer';
import { Writable } from 'readable-stream';
import elliptic, { type ec as EC, type eddsa as EdDSA } from 'elliptic';
import cryptoLib from 'crypto-browserify';

/**
 * node:crypto's KeyObject (createSecretKey, createPublicKey, createPrivateKey), sign and verify, and
 * createSign and createVerify over them: what JWT libraries (jsonwebtoken, jose's Node build) and
 * webhook signature checks use. Part of node:crypto's runtime library (bundle.ts), with crypto-browserify:
 * both load when a program first uses a member of node:crypto that is not the runtime's own (hashes, HMACs
 * and random bytes are; a program that uses only those loads neither).
 *
 * These are synchronous in Node, so they cannot be the browser's WebCrypto (whose every call is a
 * promise): RSA is BigInt arithmetic here, ECDSA and Ed25519 are elliptic's (crypto-browserify's).
 * Keys: RSA, EC (P-256, P-384, P-521, secp256k1) and Ed25519, as PEM, DER (PKCS#1, PKCS#8, SPKI, SEC1
 * and an X.509 certificate's public key) or JWK. Signatures: PKCS#1 v1.5 and PSS, ECDSA (DER or IEEE
 * P1363) and Ed25519. Encrypted private keys read with their passphrase (PBES2 PKCS#8 and OpenSSL's
 * legacy PEM encryption), not written. Not here: DSA, RSA-PSS keys, X25519.
 */

interface Hasher {
  update(data: Uint8Array): unknown;
  digest(): Buffer;
}
export interface KeyDeps {
  createHash(alg: string): Hasher;
  randomBytes(n: number): Buffer;
}

// --- errors, as Node's ---

const received = (v: unknown) =>
  v == null ? String(v) : typeof v === 'object' ? `an instance of ${v.constructor?.name ?? 'Object'}` : typeof v === 'function' ? `function ${v.name}` : `type ${typeof v} (${typeof v === 'string' ? `'${v}'` : String(v)})`;
const err = <E extends Error>(e: E, code: string) => Object.assign(e, { code });
const argType = (name: string, expected: string, v: unknown) => err(new TypeError(`The "${name}" argument must be ${expected}. Received ${received(v)}`), 'ERR_INVALID_ARG_TYPE');
const argValue = (name: string, v: unknown) => err(new TypeError(`The property '${name}' is invalid. Received ${quoted(v)}`), 'ERR_INVALID_ARG_VALUE');
const quoted = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v));
const unsupported = () => err(new Error('error:1E08010C:DECODER routines::unsupported'), 'ERR_OSSL_UNSUPPORTED');
const notEnoughData = () => err(new Error('error:0680008E:asn1 encoding routines::not enough data'), 'ERR_OSSL_ASN1_NOT_ENOUGH_DATA');
const unavailable = (what: string) => err(new Error(`${what} is not available in Sandburg's node:crypto`), 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
const invalidDigest = (alg: unknown) => err(new TypeError(`Invalid digest: ${String(alg)}`), 'ERR_CRYPTO_INVALID_DIGEST');
const invalidJwk = (kty: string) => err(new TypeError(`Invalid JWK ${kty} key`), 'ERR_CRYPTO_INVALID_JWK');
const wrongKeyType = (type: string, expected: string) => err(new TypeError(`Invalid key object type ${type}, expected ${expected}.`), 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE');

// --- DER ---

interface Tlv {
  tag: number;
  /** The contents. */
  v: Uint8Array;
  /** The whole encoding. */
  raw: Uint8Array;
}

function readTlv(b: Uint8Array, at: number): Tlv & { end: number } {
  if (at + 2 > b.length) throw notEnoughData();
  const tag = b[at];
  let len = b[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > b.length) throw notEnoughData();
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[start + i];
    start += n;
  }
  const end = start + len;
  if (end > b.length) throw notEnoughData();
  return { tag, v: b.subarray(start, end), raw: b.subarray(at, end), end };
}
/** One element that is all of b. */
function readOne(b: Uint8Array, tag?: number): Tlv {
  const t = readTlv(b, 0);
  if (t.end !== b.length || (tag !== undefined && t.tag !== tag)) throw unsupported();
  return t;
}
/** A SEQUENCE's elements. */
function children(t: Tlv): Tlv[] {
  if (t.tag !== 0x30) throw unsupported();
  const out: Tlv[] = [];
  for (let at = 0; at < t.v.length; ) {
    const c = readTlv(t.v, at);
    out.push(c);
    at = c.end;
  }
  return out;
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const head = len < 128 ? [tag, len] : len < 256 ? [tag, 0x81, len] : len < 65536 ? [tag, 0x82, len >> 8, len & 255] : [tag, 0x83, len >> 16, (len >> 8) & 255, len & 255];
  const out = new Uint8Array(head.length + len);
  out.set(head);
  let at = head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const octets = (b: Uint8Array) => tlv(0x04, b);
const bits = (b: Uint8Array) => tlv(0x03, Uint8Array.of(0), b);
const NULL = Uint8Array.of(0x05, 0);

function int(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (parseInt(hex.slice(0, 2), 16) & 0x80) hex = `00${hex}`;
  return tlv(0x02, Buffer.from(hex, 'hex'));
}
function readInt(t: Tlv): bigint {
  if (t.tag !== 0x02 || t.v.length === 0 || t.v[0] & 0x80) throw unsupported();
  return toBig(t.v);
}
function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(out));
}
function readOid(t: Tlv): string {
  if (t.tag !== 0x06 || t.v.length === 0) throw unsupported();
  const out = [Math.min(2, Math.floor(t.v[0] / 40)), t.v[0] - Math.min(2, Math.floor(t.v[0] / 40)) * 40];
  let n = 0;
  for (let i = 1; i < t.v.length; i++) {
    n = n * 128 + (t.v[i] & 0x7f);
    if (!(t.v[i] & 0x80)) {
      out.push(n);
      n = 0;
    }
  }
  return out.join('.');
}
function readBits(t: Tlv): Uint8Array {
  if (t.tag !== 0x03 || t.v.length === 0 || t.v[0] !== 0) throw unsupported();
  return t.v.subarray(1);
}

const toBig = (b: Uint8Array) => (b.length ? BigInt(`0x${Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')}`) : 0n);
function toBytes(n: bigint, len?: number): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const b = Buffer.from(hex, 'hex');
  if (len === undefined || b.length === len) return b;
  if (b.length > len) throw err(new Error('error:02000084:rsa routines::data too large for modulus'), 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS');
  const out = new Uint8Array(len);
  out.set(b, len - b.length);
  return out;
}
const bitLength = (n: bigint) => n.toString(2).length;
function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  base %= m;
  for (; exp > 0n; exp >>= 1n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
  }
  return r;
}
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
/** a^-1 mod m, or null when a and m are not coprime. */
function modInverse(a: bigint, m: bigint): bigint | null {
  let [r0, r1, t0, t1] = [m, mod(a, m), 0n, 1n];
  while (r1 !== 0n) {
    const qt = r0 / r1;
    [r0, r1, t0, t1] = [r1, r0 - qt * r1, t1, t0 - qt * t1];
  }
  return r0 === 1n ? mod(t0, m) : null;
}

const b64u = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64url');
const fromB64u = (s: unknown, kty: string) => {
  if (typeof s !== 'string') throw invalidJwk(kty);
  return new Uint8Array(Buffer.from(s, 'base64url'));
};

// --- keys ---

const OID = {
  rsa: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ec: '1.2.840.10045.2.1',
  ed25519: '1.3.101.112',
};
interface Curve {
  name: string;
  oid: string;
  jwk: string;
  elliptic: string;
  size: number;
}
const CURVES: Curve[] = [
  { name: 'prime256v1', oid: '1.2.840.10045.3.1.7', jwk: 'P-256', elliptic: 'p256', size: 32 },
  { name: 'secp384r1', oid: '1.3.132.0.34', jwk: 'P-384', elliptic: 'p384', size: 48 },
  { name: 'secp521r1', oid: '1.3.132.0.35', jwk: 'P-521', elliptic: 'p521', size: 66 },
  { name: 'secp256k1', oid: '1.3.132.0.10', jwk: 'secp256k1', elliptic: 'secp256k1', size: 32 },
];

type Rsa = { kind: 'rsa'; n: bigint; e: bigint; priv?: { d: bigint; p: bigint; q: bigint; dp: bigint; dq: bigint; qi: bigint } };
type Ec = { kind: 'ec'; curve: Curve; pub: Uint8Array; d?: Uint8Array };
type Ed = { kind: 'ed25519'; pub: Uint8Array; seed?: Uint8Array };
type Asym = Rsa | Ec | Ed;

const ecs = new Map<string, EC>();
const ecOf = (c: Curve) => {
  let e = ecs.get(c.elliptic);
  if (!e) ecs.set(c.elliptic, (e = new elliptic.ec(c.elliptic)));
  return e;
};
let ed: EdDSA | undefined;
const eddsa = () => (ed ??= new elliptic.eddsa('ed25519'));

function rsaPrivate(seqT: Tlv): Rsa {
  const f = children(seqT);
  if (f.length < 9 || readInt(f[0]) !== 0n) throw unsupported();
  const [n, e, d, p, q, dp, dq, qi] = f.slice(1, 9).map(readInt);
  return { kind: 'rsa', n, e, priv: { d, p, q, dp, dq, qi } };
}
function rsaPublic(seqT: Tlv): Rsa {
  const f = children(seqT);
  if (f.length !== 2) throw unsupported();
  return { kind: 'rsa', n: readInt(f[0]), e: readInt(f[1]) };
}
function curveOf(t: Tlv | undefined): Curve {
  const id = t && readOid(t);
  const c = CURVES.find((x) => x.oid === id);
  if (!c) throw unsupported();
  return c;
}
function ecPoint(c: Curve, pub: Uint8Array): Uint8Array {
  // As OpenSSL keeps it: uncompressed (a compressed point is decompressed).
  let key: EC.KeyPair;
  try {
    key = ecOf(c).keyFromPublic(Array.from(pub));
  } catch {
    throw unsupported();
  }
  if (!key.validate().result) throw err(new Error('error:1E08010C:DECODER routines::unsupported'), 'ERR_OSSL_UNSUPPORTED');
  return Uint8Array.from(key.getPublic(false, 'array'));
}
/** SEC1's ECPrivateKey; its curve from its parameters or, in PKCS#8, from the algorithm. */
function ecPrivate(seqT: Tlv, curve?: Curve): Ec {
  const f = children(seqT);
  if (f.length < 2 || readInt(f[0]) !== 1n || f[1].tag !== 0x04) throw unsupported();
  const params = f.find((x) => x.tag === 0xa0);
  const c = curve ?? curveOf(params && readOne(params.v));
  const d = toBytes(toBig(f[1].v), c.size);
  const pubT = f.find((x) => x.tag === 0xa1);
  const pub = pubT ? ecPoint(c, readBits(readOne(pubT.v))) : Uint8Array.from(ecOf(c).keyFromPrivate(Array.from(d)).getPublic(false, 'array'));
  return { kind: 'ec', curve: c, pub, d };
}
function edFromSeed(seed: Uint8Array): Ed {
  if (seed.length !== 32) throw unsupported();
  seed = Uint8Array.from(seed); // not a view of the caller's DER, which they may change
  return { kind: 'ed25519', seed, pub: Uint8Array.from(eddsa().keyFromSecret(Array.from(seed)).getPublic()) };
}

function fromSpki(der: Uint8Array): Asym {
  const [alg, key] = children(readOne(der));
  if (!alg || !key) throw unsupported();
  const [id, params] = children(alg);
  const pub = readBits(key);
  switch (readOid(id)) {
    case OID.rsa:
      return rsaPublic(readOne(pub));
    case OID.ec: {
      const c = curveOf(params);
      return { kind: 'ec', curve: c, pub: ecPoint(c, pub) };
    }
    case OID.ed25519:
      if (pub.length !== 32) throw unsupported();
      return { kind: 'ed25519', pub: Uint8Array.from(pub) };
    case OID.rsaPss:
      throw unavailable('An RSA-PSS key');
    default:
      throw unsupported();
  }
}
function fromPkcs8(der: Uint8Array): Asym {
  const f = children(readOne(der));
  if (f.length < 3 || f[2].tag !== 0x04) throw unsupported();
  const [id, params] = children(f[1]);
  switch (readOid(id)) {
    case OID.rsa:
      return rsaPrivate(readOne(f[2].v));
    case OID.ec:
      return ecPrivate(readOne(f[2].v), curveOf(params));
    case OID.ed25519:
      return edFromSeed(readOne(f[2].v, 0x04).v);
    case OID.rsaPss:
      throw unavailable('An RSA-PSS key');
    default:
      throw unsupported();
  }
}
/** An X.509 certificate's subject public key. */
function fromCertificate(der: Uint8Array): Asym {
  const [tbs] = children(readOne(der));
  const f = children(tbs);
  const at = f[0]?.tag === 0xa0 ? 6 : 5;
  if (!f[at]) throw unsupported();
  return fromSpki(f[at].raw);
}

function spki(k: Asym): Uint8Array {
  if (k.kind === 'rsa') return seq(seq(oid(OID.rsa), NULL), bits(seq(int(k.n), int(k.e))));
  if (k.kind === 'ec') return seq(seq(oid(OID.ec), oid(k.curve.oid)), bits(k.pub));
  return seq(seq(oid(OID.ed25519)), bits(k.pub));
}
function pkcs1Private(k: Rsa): Uint8Array {
  const p = k.priv!;
  return seq(int(0n), ...[k.n, k.e, p.d, p.p, p.q, p.dp, p.dq, p.qi].map(int));
}
function sec1(k: Ec, withParams: boolean): Uint8Array {
  return seq(int(1n), octets(k.d!), ...(withParams ? [tlv(0xa0, oid(k.curve.oid))] : []), tlv(0xa1, bits(k.pub)));
}
function pkcs8(k: Asym): Uint8Array {
  if (k.kind === 'rsa') return seq(int(0n), seq(oid(OID.rsa), NULL), octets(pkcs1Private(k)));
  if (k.kind === 'ec') return seq(int(0n), seq(oid(OID.ec), oid(k.curve.oid)), octets(sec1(k, false)));
  return seq(int(0n), seq(oid(OID.ed25519)), octets(octets(k.seed!)));
}
const publicOf = (k: Asym): Asym => (k.kind === 'rsa' ? { kind: 'rsa', n: k.n, e: k.e } : k.kind === 'ec' ? { kind: 'ec', curve: k.curve, pub: k.pub } : { kind: 'ed25519', pub: k.pub });
const isPrivate = (k: Asym) => (k.kind === 'rsa' ? !!k.priv : k.kind === 'ec' ? !!k.d : !!k.seed);

function fromJwk(jwk: Record<string, unknown>, wantPrivate: boolean): Asym {
  const kty = jwk.kty;
  if (kty === 'RSA') {
    const n = toBig(fromB64u(jwk.n, 'RSA'));
    const e = toBig(fromB64u(jwk.e, 'RSA'));
    if (!wantPrivate) return { kind: 'rsa', n, e };
    const [d, p, q, dp, dq, qi] = ['d', 'p', 'q', 'dp', 'dq', 'qi'].map((x) => toBig(fromB64u(jwk[x], 'RSA')));
    return { kind: 'rsa', n, e, priv: { d, p, q, dp, dq, qi } };
  }
  if (kty === 'EC') {
    const c = CURVES.find((x) => x.jwk === jwk.crv);
    if (!c) throw err(new TypeError('Invalid EC curve name'), 'ERR_CRYPTO_INVALID_CURVE');
    const x = fromB64u(jwk.x, 'EC');
    const y = fromB64u(jwk.y, 'EC');
    if (x.length !== c.size || y.length !== c.size) throw invalidJwk('EC');
    const pub = ecPoint(c, Uint8Array.from([4, ...x, ...y]));
    if (!wantPrivate) return { kind: 'ec', curve: c, pub };
    const d = fromB64u(jwk.d, 'EC');
    if (d.length !== c.size) throw invalidJwk('EC');
    // As OpenSSL's check: d in [1, n) and its point the given one.
    const dn = toBig(d);
    if (dn === 0n || dn >= BigInt(`0x${ecOf(c).n.toString(16)}`)) throw invalidJwk('EC');
    if (Buffer.compare(Uint8Array.from(ecOf(c).keyFromPrivate(Array.from(d)).getPublic(false, 'array')), pub) !== 0) throw invalidJwk('EC');
    return { kind: 'ec', curve: c, pub, d };
  }
  if (kty === 'OKP') {
    if (jwk.crv !== 'Ed25519') {
      if (['Ed448', 'X25519', 'X448'].includes(jwk.crv as string)) throw unavailable(`A ${String(jwk.crv)} key`);
      throw invalidJwk('OKP');
    }
    const x = fromB64u(jwk.x, 'OKP');
    if (x.length !== 32) throw invalidJwk('OKP');
    if (!wantPrivate) return { kind: 'ed25519', pub: x };
    const k = edFromSeed(fromB64u(jwk.d, 'OKP'));
    if (Buffer.compare(k.pub, x) !== 0) throw invalidJwk('OKP');
    return k;
  }
  throw err(new TypeError(`${String(kty)} is not a supported JWK key type`), 'ERR_CRYPTO_INVALID_JWK');
}
function toJwk(k: Asym, priv: boolean): Record<string, string> {
  if (k.kind === 'rsa') {
    const out: Record<string, string> = { kty: 'RSA', n: b64u(toBytes(k.n)), e: b64u(toBytes(k.e)) };
    if (priv) {
      const p = k.priv!;
      Object.assign(out, { d: b64u(toBytes(p.d)), p: b64u(toBytes(p.p)), q: b64u(toBytes(p.q)), dp: b64u(toBytes(p.dp)), dq: b64u(toBytes(p.dq)), qi: b64u(toBytes(p.qi)) });
    }
    return out;
  }
  if (k.kind === 'ec') {
    const s = k.curve.size;
    const out: Record<string, string> = { kty: 'EC', x: b64u(k.pub.subarray(1, 1 + s)), y: b64u(k.pub.subarray(1 + s)), crv: k.curve.jwk };
    if (priv) out.d = b64u(k.d!);
    return out;
  }
  const out: Record<string, string> = { kty: 'OKP', crv: 'Ed25519', x: b64u(k.pub) };
  if (priv) out.d = b64u(k.seed!);
  return out;
}

const PEM = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;
function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der.buffer, der.byteOffset, der.byteLength).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END ${label}-----\n`;
}

/** A key from PEM text: a private key (when one is wanted or allowed), a public key or a certificate's. */
function fromPem(text: string, want: 'public' | 'private' | 'any', passphrase?: unknown): Asym {
  const m = PEM.exec(text);
  if (!m) throw unsupported();
  let der: Uint8Array;
  let label = m[1];
  const headers = /^([\s\S]*?)\r?\n\r?\n/.exec(m[2].replace(/^\s+/, ''));
  if (headers && /Proc-Type:\s*4,ENCRYPTED/.test(headers[1])) {
    der = decryptLegacy(headers[1], new Uint8Array(Buffer.from(m[2].replace(/^\s+/, '').slice(headers[0].length).replace(/\s+/g, ''), 'base64')), passphrase);
  } else der = new Uint8Array(Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
  if (label === 'ENCRYPTED PRIVATE KEY') [der, label] = [decryptPkcs8(der, passphrase), 'PRIVATE KEY'];
  const priv = (k: Asym) => {
    if (want === 'public') return publicOf(k);
    return k;
  };
  switch (label) {
    case 'PRIVATE KEY':
      return priv(fromPkcs8(der));
    case 'RSA PRIVATE KEY':
      return priv(rsaPrivate(readOne(der)));
    case 'EC PRIVATE KEY':
      return priv(ecPrivate(readOne(der)));
  }
  if (want === 'private') throw unsupported();
  if (label === 'PUBLIC KEY') return fromSpki(der);
  if (label === 'RSA PUBLIC KEY') return rsaPublic(readOne(der));
  if (label === 'CERTIFICATE') return fromCertificate(der);
  throw unsupported();
}
// --- encrypted private keys ---

const PBES2 = '1.2.840.113549.1.5.13';
const PBKDF2 = '1.2.840.113549.1.5.12';
const PRFS: Record<string, string> = { '1.2.840.113549.2.7': 'sha1', '1.2.840.113549.2.8': 'sha224', '1.2.840.113549.2.9': 'sha256', '1.2.840.113549.2.10': 'sha384', '1.2.840.113549.2.11': 'sha512' };
/** PBES2's ciphers and OpenSSL's legacy PEM ones (DEK-Info): the cipher and its key length. */
const PBE_CIPHERS: Record<string, [string, number]> = {
  '2.16.840.1.101.3.4.1.2': ['aes-128-cbc', 16],
  '2.16.840.1.101.3.4.1.22': ['aes-192-cbc', 24],
  '2.16.840.1.101.3.4.1.42': ['aes-256-cbc', 32],
  '1.2.840.113549.3.7': ['des-ede3-cbc', 24],
  '1.3.14.3.2.7': ['des-cbc', 8],
};
const LEGACY_CIPHERS: Record<string, [string, number]> = { 'AES-128-CBC': ['aes-128-cbc', 16], 'AES-192-CBC': ['aes-192-cbc', 24], 'AES-256-CBC': ['aes-256-cbc', 32], 'DES-EDE3-CBC': ['des-ede3-cbc', 24], 'DES-CBC': ['des-cbc', 8] };
const badDecrypt = () => err(new Error('error:1C800064:Provider routines::bad decrypt'), 'ERR_OSSL_BAD_DECRYPT');
/** An encrypted key's passphrase; without one, Node 24's error (OpenSSL's, its prompt cancelled). */
function passphraseOf(p: unknown): Buffer {
  if (p == null) throw err(new Error('error:07880109:common libcrypto routines::interrupted or cancelled'), 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED');
  const b = bytesOf(p);
  if (!b) throw argType('key.passphrase', BYTES, p);
  return Buffer.from(b);
}
function decipher(alg: string, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  try {
    const d = cryptoLib.createDecipheriv(alg, key, iv);
    return new Uint8Array(Buffer.concat([d.update(data), d.final()]));
  } catch {
    throw badDecrypt();
  }
}
const isEncryptedPkcs8 = (der: Uint8Array) => {
  try {
    return children(readOne(der))[0]?.tag === 0x30;
  } catch {
    return false;
  }
};
/** PKCS#8's EncryptedPrivateKeyInfo (PBES2 with PBKDF2, what Node and OpenSSL write) to its PrivateKeyInfo. */
function decryptPkcs8(der: Uint8Array, passphrase: unknown): Uint8Array {
  const [algT, dataT] = children(readOne(der));
  if (!algT || dataT?.tag !== 0x04) throw unsupported();
  const [idT, paramsT] = children(algT);
  if (readOid(idT) !== PBES2) throw unavailable('A private key encrypted by PBES1');
  const [kdfT, encT] = children(paramsT);
  const [kdfId, kdfParams] = children(kdfT);
  if (readOid(kdfId) !== PBKDF2) throw unavailable('A private key encrypted with a key derivation other than PBKDF2');
  const [saltT, iterT, ...rest] = children(kdfParams);
  const prfT = rest.find((x) => x.tag === 0x30);
  const prf = prfT ? PRFS[readOid(children(prfT)[0])] : 'sha1';
  const [cipherId, ivT] = children(encT);
  const cipher = PBE_CIPHERS[readOid(cipherId)];
  if (!prf || !cipher || saltT.tag !== 0x04 || ivT?.tag !== 0x04) throw unsupported();
  const key = cryptoLib.pbkdf2Sync(passphraseOf(passphrase), saltT.v, Number(readInt(iterT)), cipher[1], prf);
  return decipher(cipher[0], key, ivT.v, dataT.v);
}
/** OpenSSL's legacy PEM encryption (Proc-Type and DEK-Info headers): EVP_BytesToKey with MD5, once. */
function decryptLegacy(headers: string, body: Uint8Array, passphrase: unknown): Uint8Array {
  const dek = /DEK-Info:\s*([A-Z0-9-]+),([0-9A-Fa-f]+)/.exec(headers);
  const cipher = dek && LEGACY_CIPHERS[dek[1]];
  if (!dek || !cipher) throw unsupported();
  const iv = Buffer.from(dek[2], 'hex');
  const pass = passphraseOf(passphrase);
  const key: Buffer[] = [];
  for (let prev = Buffer.alloc(0), got = 0; got < cipher[1]; got += prev.length) {
    prev = cryptoLib.createHash('md5').update(Buffer.concat([prev, pass, iv.subarray(0, 8)])).digest();
    key.push(prev);
  }
  return decipher(cipher[0], Buffer.concat(key).subarray(0, cipher[1]), iv, body);
}

function fromDer(der: Uint8Array, type: unknown, want: 'public' | 'private', passphrase?: unknown): Asym {
  if (want === 'private') {
    if (type === 'pkcs8') return fromPkcs8(isEncryptedPkcs8(der) ? decryptPkcs8(der, passphrase) : der);
    if (type === 'pkcs1') return rsaPrivate(readOne(der));
    if (type === 'sec1') return ecPrivate(readOne(der));
    throw argValue('key.type', type);
  }
  if (type === 'spki') return fromSpki(der);
  if (type === 'pkcs1') return rsaPublic(readOne(der));
  throw argValue('key.type', type);
}

// --- KeyObject ---

const HANDLE = Symbol('sandburg.keyHandle');
type Handle = { secret: Uint8Array } | { asym: Asym };
const handles = new WeakMap<object, Handle>();

export class KeyObject {
  #type: string;
  constructor(type: unknown, handle: unknown) {
    if (type !== 'secret' && type !== 'public' && type !== 'private') throw err(new TypeError(`The argument 'type' is invalid. Received ${received(type)}`), 'ERR_INVALID_ARG_VALUE');
    if (typeof handle !== 'object' || handle === null || !(HANDLE in handle)) throw argType('handle', 'of type object', handle);
    this.#type = type;
    handles.set(this, (handle as { [HANDLE]: Handle })[HANDLE]);
  }
  get type() {
    return this.#type;
  }
  equals(other: unknown): boolean {
    if (!(other instanceof KeyObject)) throw argType('otherKeyObject', 'an instance of KeyObject', other);
    if (other.type !== this.type) return false;
    return Buffer.compare(identity(this), identity(other)) === 0;
  }
  static from(key: unknown): never {
    throw unavailable(`KeyObject.from(${received(key)})`);
  }
  get [Symbol.toStringTag]() {
    return 'KeyObject';
  }
}
const handleOf = (k: KeyObject) => handles.get(k)!;
function identity(k: KeyObject): Uint8Array {
  const h = handleOf(k);
  if ('secret' in h) return h.secret;
  return k.type === 'private' ? pkcs8(h.asym) : spki(h.asym);
}

class SecretKeyObject extends KeyObject {
  get symmetricKeySize() {
    return (handleOf(this) as { secret: Uint8Array }).secret.length;
  }
  export(options?: unknown): Buffer | Record<string, string> {
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw argType('options', 'of type object', options);
    const secret = (handleOf(this) as { secret: Uint8Array }).secret;
    const format = options === undefined ? undefined : (options as { format?: unknown }).format;
    if (format === 'jwk') return { kty: 'oct', k: b64u(secret) };
    if (format !== undefined && format !== 'buffer') throw argValue('options.format', format);
    return Buffer.from(secret);
  }
}
class AsymmetricKeyObject extends KeyObject {
  get asymmetricKeyType() {
    return (handleOf(this) as { asym: Asym }).asym.kind;
  }
  get asymmetricKeyDetails() {
    const k = (handleOf(this) as { asym: Asym }).asym;
    if (k.kind === 'rsa') return { modulusLength: bitLength(k.n), publicExponent: k.e };
    if (k.kind === 'ec') return { namedCurve: k.curve.name };
    return {};
  }
  protected encode(options: unknown, priv: boolean): string | Buffer | Record<string, string> {
    if (typeof options !== 'object' || options === null) throw argType('options', 'of type object', options);
    const { format, type, cipher, passphrase } = options as Record<string, unknown>;
    const k = (handleOf(this) as { asym: Asym }).asym;
    if (format === 'jwk') return toJwk(k, priv);
    if (format !== 'pem' && format !== 'der') throw argValue('options.format', format);
    if (cipher !== undefined || passphrase !== undefined) throw unavailable('Encrypting a private key');
    const incompatible = (t: string, kind: string) => err(new Error(`The selected key encoding ${t} can only be used for ${kind} keys.`), 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS');
    let der: Uint8Array;
    let label: string;
    if (!priv) {
      if (type === 'spki') [der, label] = [spki(k), 'PUBLIC KEY'];
      else if (type === 'pkcs1') {
        if (k.kind !== 'rsa') throw incompatible('pkcs1', 'RSA');
        [der, label] = [seq(int(k.n), int(k.e)), 'RSA PUBLIC KEY'];
      } else throw argValue('options.type', type);
    } else if (type === 'pkcs8') [der, label] = [pkcs8(k), 'PRIVATE KEY'];
    else if (type === 'pkcs1') {
      if (k.kind !== 'rsa') throw incompatible('pkcs1', 'RSA');
      [der, label] = [pkcs1Private(k), 'RSA PRIVATE KEY'];
    } else if (type === 'sec1') {
      if (k.kind !== 'ec') throw incompatible('sec1', 'EC');
      [der, label] = [sec1(k, true), 'EC PRIVATE KEY'];
    } else throw argValue('options.type', type);
    return format === 'pem' ? pem(label, der) : Buffer.from(der);
  }
}
class PublicKeyObject extends AsymmetricKeyObject {
  export(options?: unknown) {
    return this.encode(options, false);
  }
}
class PrivateKeyObject extends AsymmetricKeyObject {
  export(options?: unknown) {
    return this.encode(options, true);
  }
}
const make = <T extends KeyObject>(C: new (type: string, handle: unknown) => T, type: string, h: Handle) => new C(type, { [HANDLE]: h });
const publicKey = (k: Asym) => make(PublicKeyObject, 'public', { asym: publicOf(k) });
const privateKey = (k: Asym) => make(PrivateKeyObject, 'private', { asym: k });

const BYTES = 'of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView';
/** What createPublicKey and createPrivateKey say they take (Node 24). */
const KEY_INPUT = 'of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL';
function bytesOf(v: unknown, encoding?: unknown): Uint8Array | null {
  if (typeof v === 'string') return Buffer.from(v, (typeof encoding === 'string' && encoding !== 'buffer' ? encoding : 'utf8') as BufferEncoding);
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

export function createSecretKey(key: unknown, encoding?: unknown): SecretKeyObject {
  const b = bytesOf(key, encoding);
  if (!b) throw argType('key', 'an instance of ArrayBuffer, Buffer, TypedArray, or DataView', key);
  return make(SecretKeyObject, 'secret', { secret: Uint8Array.from(b) });
}

/** A key from what createPublicKey, createPrivateKey, sign and verify take (not a KeyObject). */
function parseKey(input: unknown, want: 'public' | 'private' | 'any', name = 'key'): Asym {
  let key = input;
  let format: unknown = 'pem';
  let type: unknown;
  let encoding: unknown;
  let passphrase: unknown;
  if (typeof input === 'object' && input !== null && !(input instanceof KeyObject) && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
    ({ key, format = 'pem', type, encoding, passphrase } = input as Record<string, unknown>);
    if (format === 'jwk') {
      if (typeof key !== 'object' || key === null) throw argType('key.key', 'of type object', key);
      const jwk = key as Record<string, unknown>;
      return fromJwk(jwk, want === 'private' || (want === 'any' && jwk.d !== undefined));
    }
    name = 'key.key';
  }
  if (key instanceof KeyObject) throw argType(name, KEY_INPUT, key);
  const b = bytesOf(key, encoding);
  if (!b) throw argType(name, KEY_INPUT, key);
  if (format === 'pem') return fromPem(Buffer.from(b).toString('utf8'), want, passphrase);
  if (format !== 'der') throw argValue('key.format', format);
  // createPublicKey takes a private key too (its public key), as a PEM private key.
  const priv = type === 'pkcs8' || type === 'sec1' || (type === 'pkcs1' && (want === 'private' || looksPrivatePkcs1(b)));
  if (want === 'private' || priv) {
    const k = fromDer(b, type, 'private', passphrase);
    return want === 'public' ? publicOf(k) : k;
  }
  return fromDer(b, type, 'public');
}
const looksPrivatePkcs1 = (der: Uint8Array) => {
  try {
    return children(readOne(der)).length >= 9;
  } catch {
    return false;
  }
};

export function createPublicKey(key: unknown): PublicKeyObject {
  if (key instanceof KeyObject) {
    if (key.type !== 'private') throw wrongKeyType(key.type, 'private');
    return publicKey((handleOf(key) as { asym: Asym }).asym);
  }
  const k = parseKey(key, 'public');
  return publicKey(k);
}
export function createPrivateKey(key: unknown): PrivateKeyObject {
  const k = parseKey(key, 'private');
  if (!isPrivate(k)) throw unsupported();
  return privateKey(k);
}

/** sign's and verify's key: a KeyObject, PEM, DER or JWK, and the options that come with it. */
function signingKey(input: unknown, priv: boolean): { k: Asym; opts: Record<string, unknown> } {
  const opts = typeof input === 'object' && input !== null && !(input instanceof KeyObject) && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer) ? (input as Record<string, unknown>) : {};
  const key = 'key' in opts ? opts.key : input;
  if (key instanceof KeyObject) {
    if (key.type === 'secret') throw wrongKeyType('secret', priv ? 'private' : 'public or private');
    if (priv && key.type !== 'private') throw wrongKeyType(key.type, 'private');
    return { k: (handleOf(key) as { asym: Asym }).asym, opts };
  }
  const k = parseKey(input, priv ? 'private' : 'any');
  if (priv && !isPrivate(k)) throw unsupported();
  return { k, opts };
}

// --- signatures ---

const HASH_OIDS: Record<string, string> = {
  md5: '1.2.840.113549.2.5',
  sha1: '1.3.14.3.2.26',
  sha224: '2.16.840.1.101.3.4.2.4',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  ripemd160: '1.3.36.3.2.1',
};
/** A digest's name as createHash takes it, from what sign, verify and createSign take ('SHA256', 'RSA-SHA256', 'sha256WithRSAEncryption', 'ripemd160WithRSA', 'ecdsa-with-SHA256'). */
function digestName(alg: unknown): string {
  if (typeof alg !== 'string') throw argType('algorithm', 'of type string', alg);
  const n = alg
    .toLowerCase()
    .replace(/^rsa-|^ecdsa-with-/, '')
    .replace(/withrsa(encryption)?$/, '')
    .replace(/^sha-/, 'sha')
    .replace(/^rmd160$|^ripemd(-160)?$/, 'ripemd160');
  if (!(n in HASH_OIDS)) throw invalidDigest(alg);
  return n;
}

export function makeSigning(deps: KeyDeps) {
  const hash = (name: string, ...parts: Uint8Array[]) => {
    const h = deps.createHash(name);
    for (const p of parts) h.update(p);
    return new Uint8Array(h.digest());
  };
  // m^d mod n by the CRT, blinded as OpenSSL's is: on m·r^e for a random r, then times r^-1, so the
  // exponentiations never see the input (BigInt arithmetic is not constant-time).
  const rsaPrivateOp = (k: Rsa, m: bigint) => {
    const { p, q, dp, dq, qi } = k.priv!;
    const len = Math.ceil(bitLength(k.n) / 8);
    let r: bigint;
    let rInv: bigint | null;
    do {
      r = mod(toBig(deps.randomBytes(len)), k.n);
      rInv = r > 1n ? modInverse(r, k.n) : null;
    } while (rInv === null);
    const blinded = mod(m * modPow(r, k.e, k.n), k.n);
    const m1 = modPow(blinded, dp, p);
    const m2 = modPow(blinded, dq, q);
    const s = m2 + mod(qi * (m1 - m2), p) * q;
    return mod(s * rInv, k.n);
  };
  const pkcs1Encoded = (name: string, digest: Uint8Array, len: number) => {
    const t = seq(seq(oid(HASH_OIDS[name]), NULL), octets(digest));
    if (len < t.length + 11) throw err(new Error('error:02000070:rsa routines::digest too big for rsa key'), 'ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY');
    const em = new Uint8Array(len).fill(0xff);
    em[0] = 0;
    em[1] = 1;
    em[len - t.length - 1] = 0;
    em.set(t, len - t.length);
    return em;
  };
  const mgf1 = (name: string, seed: Uint8Array, len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0, at = 0; at < len; i++) {
      const block = hash(name, seed, Uint8Array.of(i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255));
      out.set(block.subarray(0, Math.min(block.length, len - at)), at);
      at += block.length;
    }
    return out;
  };
  const saltLengthOf = (opts: Record<string, unknown>, fallback: number) => {
    const s = opts.saltLength ?? fallback;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < -2) throw argValue('options.saltLength', s);
    return s;
  };
  const padding = (opts: Record<string, unknown>) => {
    const p = opts.padding ?? 1;
    if (p !== 1 && p !== 6) throw err(new Error('error:1C8000A5:Provider routines::illegal or unsupported padding mode'), 'ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE');
    return p;
  };
  const dsaEncoding = (opts: Record<string, unknown>) => {
    const e = opts.dsaEncoding ?? 'der';
    if (e !== 'der' && e !== 'ieee-p1363') throw argValue('options.dsaEncoding', e);
    return e;
  };

  /** The signature of a digest (name's) with a private RSA or EC key. */
  function signDigest(k: Asym, name: string, digest: Uint8Array, opts: Record<string, unknown>): Buffer {
    if (k.kind === 'rsa') {
      const len = Math.ceil(bitLength(k.n) / 8);
      if (padding(opts) === 1) return Buffer.from(toBytes(rsaPrivateOp(k, toBig(pkcs1Encoded(name, digest, len))), len));
      const emBits = bitLength(k.n) - 1;
      const emLen = Math.ceil(emBits / 8);
      const hLen = digest.length;
      let sLen = saltLengthOf(opts, -2);
      if (sLen === -1) sLen = hLen;
      else if (sLen === -2) sLen = emLen - hLen - 2;
      if (sLen < 0 || emLen < hLen + sLen + 2) throw err(new Error('error:0200006E:rsa routines::data too large for key size'), 'ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE');
      const salt = deps.randomBytes(sLen);
      const h = hash(name, new Uint8Array(8), digest, salt);
      const db = new Uint8Array(emLen - hLen - 1);
      db[emLen - sLen - hLen - 2] = 1;
      db.set(salt, emLen - sLen - hLen - 1);
      const mask = mgf1(name, h, db.length);
      for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
      db[0] &= 0xff >> (8 * emLen - emBits);
      const em = Uint8Array.from([...db, ...h, 0xbc]);
      return Buffer.from(toBytes(rsaPrivateOp(k, toBig(em)), len));
    }
    if (k.kind === 'ec') {
      const sig = ecOf(k.curve).keyFromPrivate(Array.from(k.d!)).sign(Array.from(digest));
      if (dsaEncoding(opts) === 'der') return Buffer.from(sig.toDER());
      return Buffer.concat([Buffer.from(sig.r.toArray('be', k.curve.size)), Buffer.from(sig.s.toArray('be', k.curve.size))]);
    }
    throw err(new Error('error:1C80007A:Provider routines::invalid digest'), 'ERR_OSSL_INVALID_DIGEST');
  }

  function verifyDigest(k: Asym, name: string, digest: Uint8Array, sig: Uint8Array, opts: Record<string, unknown>): boolean {
    if (k.kind === 'rsa') {
      const len = Math.ceil(bitLength(k.n) / 8);
      const pad = padding(opts);
      if (sig.length !== len) return false;
      const s = toBig(sig);
      if (s >= k.n) return false;
      const m = toBytes(modPow(s, k.e, k.n), len);
      if (pad === 1) return Buffer.compare(m, pkcs1Encoded(name, digest, len)) === 0;
      const emBits = bitLength(k.n) - 1;
      const emLen = Math.ceil(emBits / 8);
      if (emLen < len && m[0] !== 0) return false;
      const em = m.subarray(len - emLen);
      const hLen = digest.length;
      if (em[emLen - 1] !== 0xbc || emLen < hLen + 2) return false;
      const db = em.slice(0, emLen - hLen - 1);
      const h = em.subarray(emLen - hLen - 1, emLen - 1);
      if (db[0] & ~(0xff >> (8 * emLen - emBits))) return false;
      const mask = mgf1(name, h, db.length);
      for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
      db[0] &= 0xff >> (8 * emLen - emBits);
      const one = db.findIndex((x) => x !== 0);
      if (one < 0 || db[one] !== 1) return false;
      const salt = db.subarray(one + 1);
      let sLen = saltLengthOf(opts, -2);
      if (sLen === -1) sLen = hLen;
      if (sLen >= 0 && salt.length !== sLen) return false;
      return Buffer.compare(hash(name, new Uint8Array(8), digest, salt), h) === 0;
    }
    if (k.kind === 'ec') {
      let r: Uint8Array;
      let s: Uint8Array;
      if (dsaEncoding(opts) === 'der') {
        try {
          const f = children(readOne(sig));
          // Strict DER, as OpenSSL's check: two INTEGERs, each nonnegative and minimally encoded.
          const strict = (t: Tlv) => t.tag === 2 && t.v.length > 0 && !(t.v[0] & 0x80) && !(t.v.length > 1 && t.v[0] === 0 && !(t.v[1] & 0x80));
          if (f.length !== 2 || !strict(f[0]) || !strict(f[1])) return false;
          [r, s] = [f[0].v, f[1].v];
        } catch {
          return false;
        }
      } else {
        if (sig.length !== 2 * k.curve.size) return false;
        [r, s] = [sig.subarray(0, k.curve.size), sig.subarray(k.curve.size)];
      }
      const hex = (b: Uint8Array) => Buffer.from(b).toString('hex') || '0';
      try {
        return ecOf(k.curve).verify(Array.from(digest), { r: hex(r), s: hex(s) }, ecOf(k.curve).keyFromPublic(Array.from(k.pub)));
      } catch {
        return false;
      }
    }
    throw err(new Error('error:1C80007A:Provider routines::invalid digest'), 'ERR_OSSL_INVALID_DIGEST');
  }

  const dataOf = (data: unknown, name = 'data') => {
    const b = bytesOf(data);
    if (!b) throw argType(name, name === 'data' ? BYTES : 'an instance of Buffer, TypedArray, or DataView', data);
    return b;
  };
  const callback = <T>(cb: unknown, run: () => T): T | undefined => {
    if (cb === undefined) return run();
    if (typeof cb !== 'function') throw argType('callback', 'of type function', cb);
    let out: { e: Error | null; v?: T };
    try {
      out = { e: null, v: run() };
    } catch (e) {
      out = { e: e as Error };
    }
    queueMicrotask(() => (out.e ? cb(out.e) : cb(null, out.v)));
    return undefined;
  };

  function sign(algorithm: unknown, data: unknown, key: unknown, cb?: unknown): Buffer | undefined {
    const bytes = dataOf(data);
    return callback(cb, () => {
      const { k, opts } = signingKey(key, true);
      if (k.kind === 'ed25519') {
        if (algorithm != null) throw err(new Error('error:1C80007A:Provider routines::invalid digest'), 'ERR_OSSL_INVALID_DIGEST');
        return Buffer.from(eddsa().sign(Array.from(bytes), Array.from(k.seed!)).toBytes());
      }
      const name = algorithm == null ? 'sha256' : digestName(algorithm);
      return signDigest(k, name, hash(name, bytes), opts);
    });
  }
  function verify(algorithm: unknown, data: unknown, key: unknown, signature: unknown, cb?: unknown): boolean | undefined {
    const bytes = dataOf(data);
    const sig = dataOf(signature, 'signature');
    return callback(cb, () => {
      const { k, opts } = signingKey(key, false);
      if (k.kind === 'ed25519') {
        if (algorithm != null) throw err(new Error('error:1C80007A:Provider routines::invalid digest'), 'ERR_OSSL_INVALID_DIGEST');
        if (sig.length !== 64) return false;
        try {
          return eddsa().verify(Array.from(bytes), Array.from(sig), Array.from(k.pub));
        } catch {
          return false;
        }
      }
      const name = algorithm == null ? 'sha256' : digestName(algorithm);
      return verifyDigest(k, name, hash(name, bytes), sig, opts);
    });
  }

  /** createSign's and createVerify's: a Writable of the data, hashed as it comes. */
  class Digesting extends Writable {
    protected readonly name: string;
    protected hasher: Hasher | null;
    constructor(algorithm: unknown, options?: object) {
      super(options);
      this.name = digestName(algorithm);
      this.hasher = deps.createHash(this.name);
    }
    update(data: unknown, encoding?: unknown): this {
      if (!this.hasher) throw err(new Error('Not initialised'), 'ERR_CRYPTO_INVALID_STATE');
      const b = bytesOf(data, encoding);
      if (!b) throw argType('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data);
      this.hasher.update(b);
      return this;
    }
    _write(chunk: unknown, encoding: unknown, cb: (e?: Error | null) => void) {
      try {
        this.update(chunk, encoding);
        cb();
      } catch (e) {
        cb(e as Error);
      }
    }
    protected finish(): Uint8Array {
      if (!this.hasher) throw err(new Error('Not initialised'), 'ERR_CRYPTO_INVALID_STATE');
      const d = new Uint8Array(this.hasher.digest());
      this.hasher = null;
      return d;
    }
  }
  class Sign extends Digesting {
    sign(key: unknown, outputEncoding?: unknown): Buffer | string {
      const { k, opts } = signingKey(key, true);
      if (k.kind === 'ed25519') throw err(new Error('error:1C80007A:Provider routines::invalid digest'), 'ERR_OSSL_INVALID_DIGEST');
      const sig = signDigest(k, this.name, this.finish(), opts);
      return typeof outputEncoding === 'string' && outputEncoding !== 'buffer' ? sig.toString(outputEncoding as BufferEncoding) : sig;
    }
  }
  class Verify extends Digesting {
    verify(key: unknown, signature: unknown, signatureEncoding?: unknown): boolean {
      const { k, opts } = signingKey(key, false);
      if (k.kind === 'ed25519') throw err(new Error('error:1C80007A:Provider routines::invalid digest'), 'ERR_OSSL_INVALID_DIGEST');
      const sig = bytesOf(signature, signatureEncoding);
      if (!sig) throw argType('signature', 'of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView', signature);
      return verifyDigest(k, this.name, this.finish(), sig, opts);
    }
  }
  const createSign = (algorithm: unknown, options?: object) => new Sign(algorithm, options);
  const createVerify = (algorithm: unknown, options?: object) => new Verify(algorithm, options);
  // crypto.Sign and crypto.Verify, as Node's: called or constructed (with new, the object returned is the instance).
  const constructible = <T>(name: string, make: (algorithm: unknown, options?: object) => T, prototype: object) => {
    const fn = function (algorithm: unknown, options?: object) {
      return make(algorithm, options);
    };
    return Object.defineProperties(fn, { name: { value: name }, prototype: { value: prototype } });
  };
  const SignFn = constructible('Sign', createSign, Sign.prototype);
  const VerifyFn = constructible('Verify', createVerify, Verify.prototype);

  return { sign, verify, Sign: SignFn, Verify: VerifyFn, createSign, createVerify };
}

/**
 * crypto-browserify's publicEncrypt and its kin read PEM (or { key, padding, passphrase }): a KeyObject
 * becomes its PEM for them. They have OAEP with SHA-1 only and no label: other OAEP options are refused,
 * not ignored.
 */
export function pemForEncryption(key: unknown, op = 'publicEncrypt'): unknown {
  const asPem = (k: KeyObject) => {
    const h = handleOf(k);
    if ('secret' in h) throw wrongKeyType('secret', 'public or private');
    return k.type === 'private' ? pem('PRIVATE KEY', pkcs8(h.asym)) : pem('PUBLIC KEY', spki(h.asym));
  };
  if (key instanceof KeyObject) return asPem(key);
  if (typeof key === 'object' && key !== null && !ArrayBuffer.isView(key)) {
    const { oaepHash, oaepLabel } = key as { oaepHash?: unknown; oaepLabel?: unknown };
    if (oaepHash !== undefined && (typeof oaepHash !== 'string' || !['sha1', 'sha-1', 'rsa-sha1'].includes(oaepHash.toLowerCase()))) throw unavailable(`${op} with oaepHash ${String(oaepHash)}`);
    if (oaepLabel != null && (bytesOf(oaepLabel)?.length ?? 1) > 0) throw unavailable(`${op} with an oaepLabel`);
    if ((key as { key?: unknown }).key instanceof KeyObject) return { ...key, key: asPem((key as { key: KeyObject }).key) };
  }
  return key;
}
