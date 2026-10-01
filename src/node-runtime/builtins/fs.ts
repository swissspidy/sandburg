/**
 * node:fs over the runtime's Vfs: sync, callback and promise APIs, Stats and
 * Dirent, file descriptors, streams and (event-based) watchers.
 */
import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'readable-stream';
import { FsError, norm, type VStat, type Vfs } from '../vfs.ts';
import { bindContext } from '../async-context.ts';

type PathLike = string | Buffer | URL;
type Encoding = BufferEncoding | null | undefined;
type EncOpt = Encoding | { encoding?: Encoding; flag?: string; withFileTypes?: boolean; recursive?: boolean; force?: boolean; throwIfNoEntry?: boolean; bigint?: boolean };

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
  S_IFMT: 0o170000, S_IFREG, S_IFDIR, S_IFLNK: 0o120000,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, UV_FS_O_FILEMAP: 0,
};

export class Stats {
  dev = 1; ino: number; mode: number; nlink = 1; uid = 0; gid = 0; rdev = 0; size: number; blksize = 4096; blocks: number;
  atimeMs: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number;
  atime: Date; mtime: Date; ctime: Date; birthtime: Date;
  private kind: VStat['kind'];
  constructor(s: VStat) {
    this.kind = s.kind;
    this.ino = s.ino;
    this.size = s.size;
    this.blocks = Math.ceil(s.size / 512);
    this.mode = (s.kind === 'dir' ? S_IFDIR | 0o755 : S_IFREG | 0o644);
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = s.mtimeMs;
    this.atime = this.mtime = this.ctime = this.birthtime = new Date(s.mtimeMs);
  }
  isFile() { return this.kind === 'file'; }
  isDirectory() { return this.kind === 'dir'; }
  isSymbolicLink() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

/** fs.BigIntStats ({ bigint: true }): the same stats as BigInts, plus nanosecond times. WASI asks for these. */
export class BigIntStats {
  dev: bigint; ino: bigint; mode: bigint; nlink: bigint; uid: bigint; gid: bigint; rdev: bigint; size: bigint; blksize: bigint; blocks: bigint;
  atimeMs: bigint; mtimeMs: bigint; ctimeMs: bigint; birthtimeMs: bigint;
  atimeNs: bigint; mtimeNs: bigint; ctimeNs: bigint; birthtimeNs: bigint;
  atime: Date; mtime: Date; ctime: Date; birthtime: Date;
  private stats: Stats;
  constructor(s: Stats) {
    this.stats = s;
    const b = (n: number) => BigInt(Math.trunc(n));
    this.dev = b(s.dev); this.ino = b(s.ino); this.mode = b(s.mode); this.nlink = b(s.nlink); this.uid = b(s.uid); this.gid = b(s.gid);
    this.rdev = b(s.rdev); this.size = b(s.size); this.blksize = b(s.blksize); this.blocks = b(s.blocks);
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = b(s.mtimeMs);
    this.atimeNs = this.mtimeNs = this.ctimeNs = this.birthtimeNs = b(s.mtimeMs * 1e6);
    this.atime = s.atime; this.mtime = s.mtime; this.ctime = s.ctime; this.birthtime = s.birthtime;
  }
  isFile() { return this.stats.isFile(); }
  isDirectory() { return this.stats.isDirectory(); }
  isSymbolicLink() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

/** A glob pattern as a regular expression: `**`, `*`, `?`, `[...]` and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  const convert = (p: string): string => {
    let out = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*' && p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          out += '(?:[^/]*(?:/|$))*';
        } else out += '.*';
      } else if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else if (c === '[') {
        const end = p.indexOf(']', i + 1);
        if (end < 0) out += '\\[';
        else {
          out += `[${p.slice(i + 1, end).replace(/^!/, '^')}]`;
          i = end;
        }
      } else if (c === '{') {
        let depth = 1;
        let j = i + 1;
        for (; j < p.length && depth; j++) depth += p[j] === '{' ? 1 : p[j] === '}' ? -1 : 0;
        const inner = p.slice(i + 1, j - 1);
        const parts: string[] = [];
        let level = 0;
        let start = 0;
        for (let k = 0; k < inner.length; k++) {
          if (inner[k] === '{') level++;
          else if (inner[k] === '}') level--;
          else if (inner[k] === ',' && level === 0) {
            parts.push(inner.slice(start, k));
            start = k + 1;
          }
        }
        parts.push(inner.slice(start));
        out += `(?:${parts.map(convert).join('|')})`;
        i = j - 1;
      } else out += c.replace(/[.+^$()|\\\]]/g, '\\$&');
    }
    return out;
  };
  return new RegExp(`^${convert(pattern.replace(/^\.\//, ''))}$`);
}

export class Dirent {
  name: string;
  parentPath: string;
  path: string;
  private kind: VStat['kind'];
  constructor(name: string, dir: string, kind: VStat['kind']) {
    this.name = name;
    this.parentPath = this.path = dir;
    this.kind = kind;
  }
  isFile() { return this.kind === 'file'; }
  isDirectory() { return this.kind === 'dir'; }
  isSymbolicLink() { return false; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

export function createFs(vfs: Vfs, cwd: () => string) {
  const abs = (p: PathLike): string => {
    let s = typeof p === 'string' ? p : p instanceof URL ? decodeURIComponent(p.pathname) : Buffer.isBuffer(p) ? p.toString() : String(p);
    if (s.startsWith('file://')) s = decodeURIComponent(new URL(s).pathname);
    return norm(s.startsWith('/') ? s : `${cwd()}/${s}`);
  };
  const enc = (o: EncOpt): Encoding => (typeof o === 'string' || o === null ? o : o?.encoding);
  const toBytes = (data: unknown, e?: Encoding): Uint8Array => {
    if (typeof data === 'string') return Buffer.from(data, e ?? 'utf8');
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.from(String(data));
  };

  // --- sync API -------------------------------------------------------------
  function statSync(p: PathLike, o?: { throwIfNoEntry?: boolean; bigint?: boolean }): Stats | BigIntStats | undefined {
    try {
      const s = new Stats(vfs.stat(abs(p)));
      return o?.bigint ? new BigIntStats(s) : s;
    } catch (e) {
      if (o?.throwIfNoEntry === false && (e as FsError).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  function readFileSync(p: PathLike | number, o?: EncOpt): string | Buffer {
    const path = typeof p === 'number' ? fdPath(p) : abs(p);
    const buf = Buffer.from(vfs.read(path));
    const e = enc(o);
    return e ? buf.toString(e) : buf;
  }
  function writeFileSync(p: PathLike | number, data: unknown, o?: EncOpt): void {
    const flag = typeof o === 'object' && o ? o.flag : undefined;
    const path = typeof p === 'number' ? fdPath(p) : abs(p);
    vfs.write(path, toBytes(data, enc(o)), flag?.startsWith('a'));
  }
  function readdirSync(p: PathLike, o?: EncOpt): (string | Dirent)[] {
    const dir = abs(p);
    const recursive = typeof o === 'object' && o?.recursive;
    const names = recursive ? walk(dir, '') : vfs.readdir(dir);
    if (typeof o === 'object' && o?.withFileTypes) {
      return names.map((n) => {
        const full = `${dir}/${n}`;
        const slash = n.lastIndexOf('/');
        return new Dirent(slash >= 0 ? n.slice(slash + 1) : n, slash >= 0 ? `${dir}/${n.slice(0, slash)}` : dir, vfs.stat(full).kind);
      });
    }
    return names;
  }
  function walk(dir: string, prefix: string): string[] {
    const out: string[] = [];
    for (const n of vfs.readdir(dir)) {
      const rel = prefix ? `${prefix}/${n}` : n;
      out.push(rel);
      if (vfs.stat(`${dir}/${n}`).kind === 'dir') out.push(...walk(`${dir}/${n}`, rel));
    }
    return out;
  }
  function rmSync(p: PathLike, o?: { recursive?: boolean; force?: boolean }): void {
    const path = abs(p);
    if (!vfs.exists(path)) {
      if (o?.force) return;
      throw new FsError('ENOENT', 'rm', path);
    }
    if (vfs.stat(path).kind === 'dir') {
      if (!o?.recursive) throw new FsError('EISDIR', 'rm', path);
      vfs.rmdir(path, true);
    } else vfs.unlink(path);
  }
  function copyFileSync(from: PathLike, to: PathLike, mode = 0): void {
    if (mode & constants.COPYFILE_EXCL && vfs.exists(abs(to))) throw new FsError('EEXIST', 'copyfile', abs(to));
    vfs.write(abs(to), new Uint8Array(vfs.read(abs(from))));
  }
  function cpSync(from: PathLike, to: PathLike, o?: { recursive?: boolean }): void {
    const src = abs(from);
    if (vfs.stat(src).kind === 'dir') {
      if (!o?.recursive) throw new FsError('EISDIR', 'cp', src);
      vfs.mkdir(abs(to), true);
      for (const n of vfs.readdir(src)) cpSync(`${src}/${n}`, `${abs(to)}/${n}`, o);
    } else copyFileSync(from, to);
  }
  function accessSync(p: PathLike): void {
    vfs.stat(abs(p), 'access');
  }
  function realpathSync(p: PathLike): string {
    const path = abs(p);
    vfs.stat(path, 'realpath');
    return path;
  }
  realpathSync.native = realpathSync;
  function mkdtempSync(prefix: string): string {
    const path = abs(`${prefix}${Math.random().toString(36).slice(2, 8)}`);
    vfs.mkdir(path, true);
    return path;
  }

  // --- file descriptors ---------------------------------------------------------
  const fds = new Map<number, { path: string; pos: number; append: boolean }>();
  let nextFd = 20;
  function fdPath(fd: number): string {
    const f = fds.get(fd);
    if (!f) throw new FsError('EBADF', 'read', String(fd));
    return f.path;
  }
  function openSync(p: PathLike, flags: string | number = 'r'): number {
    const path = abs(p);
    const f = typeof flags === 'number' ? (flags & constants.O_WRONLY || flags & constants.O_RDWR ? (flags & constants.O_APPEND ? 'a' : 'w') : 'r') : flags;
    if (f.startsWith('r')) vfs.stat(path, 'open');
    else if (f.includes('x') && vfs.exists(path)) throw new FsError('EEXIST', 'open', path);
    else if (f.startsWith('w') || !vfs.exists(path)) vfs.write(path, new Uint8Array());
    const fd = nextFd++;
    fds.set(fd, { path, pos: 0, append: f.startsWith('a') });
    return fd;
  }
  function closeSync(fd: number): void {
    fds.delete(fd);
  }
  function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.length - offset, position: number | null = null): number {
    const f = fds.get(fd);
    if (!f) throw new FsError('EBADF', 'read', String(fd));
    const data = vfs.read(f.path);
    const pos = position ?? f.pos;
    const n = Math.max(0, Math.min(length, data.length - pos));
    buffer.set(data.subarray(pos, pos + n), offset);
    if (position === null) f.pos += n;
    return n;
  }
  function writeSync(fd: number, data: unknown, ...rest: unknown[]): number {
    const f = fds.get(fd);
    if (!f) throw new FsError('EBADF', 'write', String(fd));
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = Buffer.from(data, (typeof rest[1] === 'string' ? rest[1] : 'utf8') as BufferEncoding);
    else {
      const b = toBytes(data);
      const offset = typeof rest[0] === 'number' ? rest[0] : 0;
      const length = typeof rest[1] === 'number' ? rest[1] : b.length - offset;
      bytes = b.subarray(offset, offset + length);
    }
    // writeSync(fd, data, offset, length, position): an explicit position does not move the file position.
    const position = typeof data === 'string' ? rest[0] : rest[2];
    if (f.append) vfs.writeAt(f.path, bytes, 'end');
    else if (typeof position === 'number') vfs.writeAt(f.path, bytes, position);
    else {
      vfs.writeAt(f.path, bytes, f.pos);
      f.pos += bytes.length;
    }
    return bytes.length;
  }
  function writevSync(fd: number, buffers: Uint8Array[], position?: number | null): number {
    let total = 0;
    for (const b of buffers) total += writeSync(fd, b, 0, b.length, position === null || position === undefined ? undefined : position + total);
    return total;
  }
  function readvSync(fd: number, buffers: Uint8Array[], position?: number | null): number {
    let total = 0;
    for (const b of buffers) {
      const n = readSync(fd, b, 0, b.length, position === null || position === undefined ? null : position + total);
      total += n;
      if (n < b.length) break;
    }
    return total;
  }
  function fstatSync(fd: number, o?: { bigint?: boolean }): Stats {
    const s = new Stats(vfs.stat(fdPath(fd)));
    return (o?.bigint ? new BigIntStats(s) : s) as Stats;
  }
  function ftruncateSync(fd: number, len = 0): void {
    vfs.write(fdPath(fd), new Uint8Array(vfs.read(fdPath(fd)).subarray(0, len)));
  }

  const sync = {
    existsSync: (p: PathLike) => {
      try {
        return vfs.exists(abs(p));
      } catch {
        return false;
      }
    },
    statSync,
    lstatSync: statSync,
    readFileSync,
    writeFileSync,
    appendFileSync: (p: PathLike, data: unknown, o?: EncOpt) => vfs.write(abs(p), toBytes(data, enc(o)), true),
    readdirSync,
    mkdirSync: (p: PathLike, o?: { recursive?: boolean } | number) => vfs.mkdir(abs(p), typeof o === 'object' && !!o?.recursive),
    rmdirSync: (p: PathLike, o?: { recursive?: boolean }) => vfs.rmdir(abs(p), !!o?.recursive),
    rmSync,
    unlinkSync: (p: PathLike) => vfs.unlink(abs(p)),
    renameSync: (a: PathLike, b: PathLike) => vfs.rename(abs(a), abs(b)),
    copyFileSync,
    cpSync,
    accessSync,
    realpathSync,
    mkdtempSync,
    openSync,
    closeSync,
    readSync,
    writeSync,
    fstatSync,
    ftruncateSync,
    writevSync,
    readvSync,
    truncateSync: (p: PathLike, len = 0) => vfs.write(abs(p), new Uint8Array(vfs.read(abs(p)).subarray(0, len))),
    fsyncSync: () => {},
    fdatasyncSync: () => {},
    chmodSync: () => {},
    chownSync: () => {},
    utimesSync: () => {},
    futimesSync: () => {},
    lutimesSync: () => {},
    symlinkSync: (_t: PathLike, p: PathLike) => {
      throw new FsError('EINVAL', 'symlink', abs(p));
    },
    readlinkSync: (p: PathLike) => {
      throw new FsError('EINVAL', 'readlink', abs(p));
    },
    linkSync: (a: PathLike, b: PathLike) => copyFileSync(a, b),
    opendirSync: (p: PathLike) => {
      const entries = readdirSync(p, { withFileTypes: true }) as Dirent[];
      return {
        path: abs(p),
        readSync: () => entries.shift() ?? null,
        read: async () => entries.shift() ?? null,
        closeSync: () => {},
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          yield* entries;
        },
      };
    },
    statfsSync: () => ({ type: 0, bsize: 4096, blocks: 1e6, bfree: 1e6, bavail: 1e6, files: 1e6, ffree: 1e6 }),
  };

  // --- callback and promise APIs, derived from the sync ones ---------------------
  const callbackified: Record<string, (...args: unknown[]) => void> = {};
  const promisified: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(sync)) {
    if (name === 'existsSync' || !name.endsWith('Sync')) continue;
    const base = name.slice(0, -4);
    callbackified[base] = (...args: unknown[]) => {
      const cb = typeof args.at(-1) === 'function' ? (bindContext(args.pop() as never) as (e: unknown, v?: unknown) => void) : () => {};
      let result: unknown;
      let error: unknown = null;
      try {
        result = (fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        error = e;
      }
      setTimeout(() => (error ? cb(error) : cb(null, result)), 0);
    };
    promisified[base] = async (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
  }
  // fs.read/fs.write callbacks take (err, bytes, buffer)
  callbackified.read = (fd, buffer, offset, length, position, cb) => {
    const done = bindContext(cb as never) as (e: unknown, n?: number, b?: unknown) => void;
    try {
      const n = readSync(fd as number, buffer as Uint8Array, offset as number, length as number, position as number | null);
      setTimeout(() => done(null, n, buffer), 0);
    } catch (e) {
      setTimeout(() => done(e), 0);
    }
  };
  const exists = (p: PathLike, cb: (b: boolean) => void) => setTimeout(() => cb(sync.existsSync(p)), 0);

  class FileHandle {
    fd: number;
    constructor(fd: number) {
      this.fd = fd;
    }
    readFile(o?: EncOpt) { return Promise.resolve(readFileSync(this.fd, o)); }
    writeFile(d: unknown, o?: EncOpt) { return Promise.resolve(writeFileSync(this.fd, d, o)); }
    async read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null) {
      return { bytesRead: readSync(this.fd, buffer, offset, length, position ?? null), buffer };
    }
    async write(data: unknown, ...rest: unknown[]) { return { bytesWritten: writeSync(this.fd, data, ...rest), buffer: data }; }
    async stat() { return fstatSync(this.fd); }
    async truncate(len?: number) { ftruncateSync(this.fd, len); }
    async sync() {}
    async close() { closeSync(this.fd); }
    async [Symbol.asyncDispose]() { closeSync(this.fd); }
  }
  promisified.open = async (p, flags) => new FileHandle(openSync(p as PathLike, flags as string));
  promisified.access = async (p) => accessSync(p as PathLike);
  promisified.rm = async (p, o) => rmSync(p as PathLike, o as { recursive?: boolean; force?: boolean });
  promisified.exists = async (p) => sync.existsSync(p as PathLike);

  // --- streams and watchers --------------------------------------------------------
  /**
   * fs.ReadStream / fs.WriteStream. send and others check `instanceof`, and older
   * code (graceful-fs, webpack's cache) calls them without `new` or via
   * `.apply(this)`, so these are function constructors, as in Node.
   */
  type ReadOpts = EncOpt & { start?: number; end?: number; highWaterMark?: number };
  interface ReadStream extends InstanceType<typeof Readable> {
    path: string;
    bytesRead: number;
    pending: boolean;
    _data: Uint8Array | null;
    _pos: number;
    _end?: number;
    close(cb?: () => void): void;
  }
  interface WriteStream extends InstanceType<typeof Writable> {
    path: string;
    bytesWritten: number;
    pending: boolean;
    close(cb?: () => void): void;
  }
  const ReadStream = function (this: ReadStream | undefined, p: PathLike, o?: ReadOpts): ReadStream {
    if (!(this instanceof ReadStream)) return new (ReadStream as unknown as new (p: PathLike, o?: ReadOpts) => ReadStream)(p, o);
    const opts = (typeof o === 'object' && o ? o : {}) as { start?: number; end?: number; highWaterMark?: number };
    (Readable as unknown as Function).call(this, { encoding: enc(o) ?? undefined, highWaterMark: opts.highWaterMark });
    this.path = typeof p === 'string' ? p : abs(p);
    this.bytesRead = 0;
    this.pending = false;
    this._data = null;
    this._pos = opts.start ?? 0;
    this._end = opts.end;
    return this;
  } as unknown as { new (p: PathLike, o?: ReadOpts): ReadStream; (p: PathLike, o?: ReadOpts): ReadStream; prototype: ReadStream };
  Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
  Object.setPrototypeOf(ReadStream, Readable);
  ReadStream.prototype._read = function (this: ReadStream, size: number) {
    try {
      this._data ??= vfs.read(abs(this.path));
      const stop = Math.min(this._end === undefined ? this._data.length : this._end + 1, this._pos + size);
      if (this._pos >= stop) return void this.push(null);
      const chunk = Buffer.from(this._data.subarray(this._pos, stop));
      this.bytesRead += chunk.length;
      this._pos = stop;
      this.push(chunk);
    } catch (e) {
      this.destroy(e as Error);
    }
  };
  ReadStream.prototype.close = function (this: ReadStream, cb?: () => void) {
    this.destroy();
    cb?.();
  };

  const WriteStream = function (this: WriteStream | undefined, p: PathLike, o?: EncOpt): WriteStream {
    if (!(this instanceof WriteStream)) return new (WriteStream as unknown as new (p: PathLike, o?: EncOpt) => WriteStream)(p, o);
    (Writable as unknown as Function).call(this);
    this.path = abs(p);
    this.bytesWritten = 0;
    this.pending = false;
    const flag = typeof o === 'object' && o ? o.flag : undefined;
    if (!flag?.startsWith('a')) vfs.write(this.path, new Uint8Array());
    return this;
  } as unknown as { new (p: PathLike, o?: EncOpt): WriteStream; (p: PathLike, o?: EncOpt): WriteStream; prototype: WriteStream };
  Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
  Object.setPrototypeOf(WriteStream, Writable);
  WriteStream.prototype._write = function (this: WriteStream, chunk: unknown, encoding: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      const bytes = toBytes(chunk, encoding as Encoding);
      vfs.write(this.path, bytes, true);
      this.bytesWritten += bytes.length;
      cb();
    } catch (e) {
      cb(e as Error);
    }
  };
  WriteStream.prototype.close = function (this: WriteStream, cb?: () => void) {
    this.end(cb);
  };

  const createReadStream = (p: PathLike, o?: ReadOpts) => new ReadStream(p, o);
  const createWriteStream = (p: PathLike, o?: EncOpt) => new WriteStream(p, o);
  function watch(p: PathLike, o?: unknown, listener?: (event: string, filename: string) => void) {
    const cb = typeof o === 'function' ? (o as typeof listener) : listener;
    const root = abs(p);
    const w = new EventEmitter() as EventEmitter & { close(): void; ref(): unknown; unref(): unknown };
    const off = vfs.watch((event, changed) => {
      if (changed === root || changed.startsWith(root + '/')) {
        const name = changed === root ? changed.slice(changed.lastIndexOf('/') + 1) : changed.slice(root.length + 1);
        w.emit('change', event, name);
      }
    });
    if (cb) w.on('change', cb);
    w.close = () => {
      off();
      w.emit('close');
    };
    w.ref = w.unref = () => w;
    return w;
  }
  const fileWatchers = new Map<string, () => void>();
  function watchFile(p: PathLike, o: unknown, listener?: (curr: Stats, prev: Stats) => void) {
    const cb = (typeof o === 'function' ? o : listener) as (curr: Stats, prev: Stats) => void;
    const path = abs(p);
    let prev = (statSync(path, { throwIfNoEntry: false }) as Stats | undefined) ?? new Stats({ kind: 'file', size: 0, mtimeMs: 0, ino: 0 });
    const off = vfs.watch((_e, changed) => {
      if (changed !== path) return;
      const curr = (statSync(path, { throwIfNoEntry: false }) as Stats | undefined) ?? new Stats({ kind: 'file', size: 0, mtimeMs: 0, ino: 0 });
      cb(curr, prev);
      prev = curr;
    });
    fileWatchers.set(path, off);
    return { ref() { return this; }, unref() { return this; } };
  }

  // --- glob (Node 22) ------------------------------------------------------------------
  type GlobOpts = { cwd?: PathLike; exclude?: ((p: string | Dirent) => boolean) | string[]; withFileTypes?: boolean };
  function globSync(pattern: string | string[], o: GlobOpts = {}): (string | Dirent)[] {
    const cwdDir = abs(o.cwd ?? '.');
    const excludes = Array.isArray(o.exclude) ? o.exclude.map(globToRegExp) : [];
    const excluded = (rel: string, d: Dirent) =>
      excludes.some((r) => r.test(rel)) || (typeof o.exclude === 'function' && o.exclude(o.withFileTypes ? d : rel));
    const found = new Map<string, Dirent>();
    for (const pat of Array.isArray(pattern) ? pattern : [pattern]) {
      const absolute = pat.startsWith('/');
      const segs = pat.split('/');
      let fixed = 0;
      while (fixed < segs.length - 1 && !/[*?[{]/.test(segs[fixed])) fixed++;
      const re = globToRegExp(pat);
      const maxDepth = pat.includes('**') ? Infinity : segs.length - fixed;
      const baseRel = segs.slice(0, fixed).join('/');
      const base = absolute ? norm(baseRel || '/') : baseRel ? norm(`${cwdDir}/${baseRel}`) : cwdDir;
      const walk = (dir: string, rel: string, depth: number) => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
        } catch {
          return;
        }
        for (const d of entries) {
          const childRel = rel ? `${rel}/${d.name}` : d.name;
          const shown = absolute ? `${base === '/' ? '' : base}/${childRel}` : baseRel ? `${baseRel}/${childRel}` : childRel;
          if (excluded(shown, d)) continue;
          if (re.test(shown)) found.set(shown, d);
          if (d.isDirectory() && depth + 1 < maxDepth) walk(`${dir}/${d.name}`, childRel, depth + 1);
        }
      };
      walk(base, '', 0);
    }
    return o.withFileTypes ? [...found.values()] : [...found.keys()];
  }
  function glob(pattern: string | string[], o?: GlobOpts | ((e: Error | null, m?: unknown) => void), cb?: (e: Error | null, m?: unknown) => void) {
    const done = (typeof o === 'function' ? o : cb)!;
    const opts = typeof o === 'object' ? o : {};
    try {
      const matches = globSync(pattern, opts);
      setTimeout(() => done(null, matches), 0);
    } catch (e) {
      setTimeout(() => done(e as Error), 0);
    }
  }
  promisified.glob = ((pattern: string | string[], o?: GlobOpts) => {
    const matches = globSync(pattern, o);
    return (async function* () {
      yield* matches;
    })();
  }) as never;

  const promises = { ...promisified, constants };
  return {
    ...sync,
    ...callbackified,
    globSync,
    glob,
    exists,
    createReadStream,
    createWriteStream,
    ReadStream,
    WriteStream,
    watch,
    watchFile,
    unwatchFile: (p: PathLike) => {
      fileWatchers.get(abs(p))?.();
      fileWatchers.delete(abs(p));
    },
    promises,
    constants,
    Stats,
    Dirent,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
  };
}
