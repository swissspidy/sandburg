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
