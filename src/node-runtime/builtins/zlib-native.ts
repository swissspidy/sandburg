/**
 * zlib's gzip, deflate and raw deflate streams (createGzip, createGunzip, createDeflate, …) and
 * their callback forms, on the browser's native CompressionStream / DecompressionStream. The
 * JavaScript port (browserify-zlib) takes seconds for tens of megabytes; webpack gzips its
 * persistent cache this way (Next.js' dev cache is 35–44 MB). The output is valid gzip/deflate, but
 * not byte for byte what Node's zlib makes at a given level; options such as level are not applied.
 * The synchronous functions (gzipSync, …) stay on the JavaScript port: there is no synchronous
 * native API.
 */
import { Transform } from 'stream';

type Format = 'gzip' | 'deflate' | 'deflate-raw';

function nativeTransform(format: Format, compress: boolean): Transform {
  const stream = compress ? new CompressionStream(format) : new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let failed: Error | null = null;
  const t = new Transform({
    transform(chunk: Uint8Array, _enc: string, cb: (e?: Error | null) => void) {
      if (failed) return cb(failed);
      // A view of shared memory is copied (the native streams do not take one).
      const bytes = chunk.buffer instanceof ArrayBuffer ? (chunk as Uint8Array<ArrayBuffer>) : new Uint8Array(chunk);
      writer.write(bytes).then(() => cb(), (e: Error) => cb(failed ?? e));
    },
    flush(cb: (e?: Error | null) => void) {
      writer.close().then(
        () => pumped.then(() => cb(failed), cb),
        (e: Error) => cb(failed ?? e),
      );
    },
  });
  const pumped = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      t.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  })().catch((e: Error) => {
    failed = Object.assign(new Error(compress ? e.message : 'incorrect header check'), { code: 'Z_DATA_ERROR', errno: -3 });
    t.destroy(failed);
  });
  // zlib stream members that callers use.
  Object.assign(t, {
    bytesWritten: 0,
    params: (_level: number, _strategy: number, cb?: () => void) => cb && queueMicrotask(cb),
    flush: (kind?: number | (() => void), cb?: () => void) => {
      const done = typeof kind === 'function' ? kind : cb;
      if (done) queueMicrotask(done);
    },
    close: (cb?: () => void) => {
      t.destroy();
      if (cb) queueMicrotask(cb);
    },
  });
  return t;
}

function convenience(format: Format, compress: boolean) {
  return (input: Uint8Array | string, options: unknown, cb?: (err: Error | null, result?: Buffer) => void) => {
    const done = (typeof options === 'function' ? options : cb) as (err: Error | null, result?: Buffer) => void;
    const t = nativeTransform(format, compress);
    const chunks: Buffer[] = [];
    t.on('data', (c: Buffer) => chunks.push(c));
    t.on('end', () => done(null, Buffer.concat(chunks)));
    t.on('error', (e: Error) => done(e));
    t.end(typeof input === 'string' ? Buffer.from(input) : input);
  };
}

export const nativeZlib = {
  createGzip: () => nativeTransform('gzip', true),
  createGunzip: () => nativeTransform('gzip', false),
  createDeflate: () => nativeTransform('deflate', true),
  createInflate: () => nativeTransform('deflate', false),
  createDeflateRaw: () => nativeTransform('deflate-raw', true),
  createInflateRaw: () => nativeTransform('deflate-raw', false),
  gzip: convenience('gzip', true),
  gunzip: convenience('gzip', false),
  deflate: convenience('deflate', true),
  inflate: convenience('deflate', false),
  deflateRaw: convenience('deflate-raw', true),
  inflateRaw: convenience('deflate-raw', false),
};
