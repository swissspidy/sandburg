// The browser polyfills implement Node's APIs; type them as Node's modules.
declare module 'readable-stream' {
  import stream = require('node:stream');
  export = stream;
}
declare module 'path-browserify' {
  import path = require('node:path');
  export = path;
}
declare module 'querystring-es3' {
  import qs = require('node:querystring');
  export = qs;
}
declare module 'crypto-browserify' {
  import crypto = require('node:crypto');
  export = crypto;
}
declare module 'browserify-zlib' {
  import zlib = require('node:zlib');
  export = zlib;
}
declare module '@napi-rs/wasm-runtime';
declare module '@pkgjs/parseargs';
declare module 'sha.js/hash.js' {
  const Hash: { prototype: { update(data: unknown, enc?: string): unknown } };
  export default Hash;
}

/** The host's esbuild version (bundle.ts defines it). */
declare const __SANDBURG_ESBUILD__: string;

/** elliptic, as node:crypto's key module (builtins/crypto-keys.ts) uses it. */
declare module 'elliptic' {
  interface BN {
    toArray(endian: 'be', length?: number): number[];
    toString(base: 16): string;
  }
  interface Signature {
    r: BN;
    s: BN;
    toDER(): number[];
  }
  export namespace ec {
    interface KeyPair {
      getPublic(compact: boolean, enc: 'array'): number[];
      sign(msg: number[]): Signature;
      validate(): { result: boolean; reason: string | null };
    }
  }
  export class ec {
    constructor(curve: string);
    /** The curve's order. */
    n: BN;
    keyFromPrivate(priv: number[]): ec.KeyPair;
    keyFromPublic(pub: number[]): ec.KeyPair;
    verify(msg: number[], signature: { r: string; s: string }, key: ec.KeyPair): boolean;
  }
  export namespace eddsa {
    interface KeyPair {
      getPublic(): number[];
    }
  }
  export class eddsa {
    constructor(curve: 'ed25519');
    keyFromSecret(secret: number[]): eddsa.KeyPair;
    sign(msg: number[], secret: number[]): { toBytes(): number[] };
    verify(msg: number[], sig: number[], pub: number[]): boolean;
  }
  const elliptic: { ec: typeof ec; eddsa: typeof eddsa };
  export default elliptic;
}
