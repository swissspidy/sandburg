/**
 * zlib's gzip, deflate and raw deflate streams (createGzip, createGunzip, createDeflate, …) and
 * their callback forms, on the browser's native CompressionStream / DecompressionStream. The
 * JavaScript port (browserify-zlib) takes seconds for tens of megabytes; webpack gzips its
 * persistent cache this way (Next.js' dev cache is 35–44 MB). The output is valid gzip/deflate, but
 * not byte for byte what Node's zlib makes at a given level; options such as level are not applied.
 * The synchronous functions (gzipSync, …) stay on the JavaScript port: there is no synchronous
 * native API.
 *
 * A native compressor cannot flush: CompressionStream has no Z_SYNC_FLUSH, so the bytes of what was
 * written so far may stay inside it. A compressing stream therefore holds its input until it knows
 * which kind it is. If `flush()` is called first (HTTP compression middleware flushing a streamed
 * response), it becomes the JavaScript port, which flushes as Node does. If 1 MB arrives, or the
 * input ends, first, it becomes native: bulk data such as webpack's cache packs. A native stream
 * that is flushed later waits for what was written to be taken in, but cannot force it out.
 */
import { Transform } from 'stream';
import zlibBrowserify from 'browserify-zlib';

type Format = 'gzip' | 'deflate' | 'deflate-raw';

const HOLD = 1024 * 1024;
// browserify-zlib has its constants on the module, not on `constants`.
const Z_FULL_FLUSH = (zlibBrowserify as unknown as { Z_FULL_FLUSH: number }).Z_FULL_FLUSH;

type Callback = (e?: Error | null) => void;

const ported: Record<Format, () => Transform> = {
  gzip: () => zlibBrowserify.createGzip() as unknown as Transform,
  deflate: () => zlibBrowserify.createDeflate() as unknown as Transform,
  'deflate-raw': () => zlibBrowserify.createDeflateRaw() as unknown as Transform,
};

/** A compressing stream: native, or the JavaScript port if it is flushed before 1 MB arrives. */
function compressor(format: Format): Transform {
  let inner: Transform | null = null;
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  const t = new Transform({
    transform(chunk: Uint8Array, _enc: string, cb: Callback) {
      if (inner) return void (inner.write(chunk) ? cb() : inner.once('drain', () => cb()));
      held.push(chunk);
      heldBytes += chunk.length;
      if (heldBytes >= HOLD) choose(nativeTransform(format, true));
      cb();
    },
    flush(cb: Callback) {
      if (!inner) choose(nativeTransform(format, true));
      inner!.once('end', () => cb());
      inner!.end();
    },
  });
  const choose = (stream: Transform) => {
    inner = stream;
    inner.on('data', (c: Buffer) => t.push(c));
    inner.on('error', (e: Error) => t.destroy(e));
    for (const c of held) inner.write(c);
    held = [];
  };
  Object.assign(t, {
    bytesWritten: 0,
    params: (_level: number, _strategy: number, cb?: () => void) => cb && queueMicrotask(cb),
    flush: (kind?: number | (() => void), cb?: () => void) => {
      const done = typeof kind === 'function' ? kind : cb;
      // Written chunks are still in this stream's buffer: flush after them, as Node does.
      t.write(Buffer.alloc(0), () => {
        if (!inner) choose(ported[format]());
        const flush = (inner as unknown as { flush(kind: number | undefined, cb: () => void): void }).flush;
        flush.call(inner, typeof kind === 'number' ? kind : Z_FULL_FLUSH, () => done && done());
      });
    },
    close: (cb?: () => void) => {
      t.destroy();
      inner?.destroy();
      if (cb) queueMicrotask(cb);
    },
  });
  return t;
}

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
    // What was written has been taken in (the native streams cannot be made to emit it).
    flush: (kind?: number | (() => void), cb?: () => void) => {
      const done = typeof kind === 'function' ? kind : cb;
      writer.ready.then(() => setTimeout(() => done && done()), () => done && done());
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
  createGzip: () => compressor('gzip'),
  createGunzip: () => nativeTransform('gzip', false),
  createDeflate: () => compressor('deflate'),
  createInflate: () => nativeTransform('deflate', false),
  createDeflateRaw: () => compressor('deflate-raw'),
  createInflateRaw: () => nativeTransform('deflate-raw', false),
  gzip: convenience('gzip', true),
  gunzip: convenience('gzip', false),
  deflate: convenience('deflate', true),
  inflate: convenience('deflate', false),
  deflateRaw: convenience('deflate-raw', true),
  inflateRaw: convenience('deflate-raw', false),
};
