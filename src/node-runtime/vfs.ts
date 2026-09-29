/**
 * The runtime's file system: an in-memory tree. Project files and everything
 * the app writes live in memory; node_modules files are known from the host's
 * index and fetched on first read (synchronously, which workers allow).
 */

export type NodeKind = 'file' | 'dir';

export interface VStat {
  kind: NodeKind;
  size: number;
  mtimeMs: number;
  ino: number;
}

export class FsError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path: string;
  constructor(code: string, syscall: string, path: string) {
    super(`${code}: ${ERRORS[code] ?? 'error'}, ${syscall} '${path}'`);
    this.code = code;
    this.errno = -(ERRNO[code] ?? 1);
    this.syscall = syscall;
    this.path = path;
  }
}

const ERRORS: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty',
  EINVAL: 'invalid argument',
  EBADF: 'bad file descriptor',
};
const ERRNO: Record<string, number> = { ENOENT: 2, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, ENOTEMPTY: 39, EINVAL: 22, EBADF: 9 };

interface FileNode {
  data: Uint8Array | null; // null: not fetched yet (remote)
  size: number;
  mtimeMs: number;
  ino: number;
}

export type WatchListener = (event: 'rename' | 'change', path: string) => void;

export class Vfs {
  private files = new Map<string, FileNode>();
  private dirs = new Map<string, Set<string>>([['/', new Set()]]);
  private dirMtimes = new Map<string, number>();
  private inos = 1;
  private watchers = new Set<WatchListener>();
  private fetchRemote: (path: string) => Uint8Array;

  constructor(fetchRemote: (path: string) => Uint8Array) {
    this.fetchRemote = fetchRemote;
  }

  /** Registers a remote file (fetched on first read). */
  addRemote(path: string, size: number): void {
    this.ensureDir(parent(path));
    this.dirs.get(parent(path))!.add(base(path));
    this.files.set(path, { data: null, size, mtimeMs: 0, ino: this.inos++ });
  }

  watch(listener: WatchListener): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  exists(path: string): boolean {
    path = norm(path);
    return this.files.has(path) || this.dirs.has(path);
  }

  stat(path: string, syscall = 'stat'): VStat {
    path = norm(path);
    const f = this.files.get(path);
    if (f) return { kind: 'file', size: f.data ? f.data.length : f.size, mtimeMs: f.mtimeMs, ino: f.ino };
    if (this.dirs.has(path)) return { kind: 'dir', size: 4096, mtimeMs: this.dirMtimes.get(path) ?? 0, ino: 0 };
    throw new FsError('ENOENT', syscall, path);
  }

  read(path: string): Uint8Array {
    path = norm(path);
    const f = this.files.get(path);
    if (!f) throw new FsError(this.dirs.has(path) ? 'EISDIR' : 'ENOENT', 'open', path);
    if (!f.data) f.data = this.fetchRemote(path);
    return f.data;
  }

  write(path: string, data: Uint8Array, append = false): void {
    path = norm(path);
    if (this.dirs.has(path)) throw new FsError('EISDIR', 'open', path);
    const dir = parent(path);
    if (!this.dirs.has(dir)) throw new FsError('ENOENT', 'open', path);
    const existing = this.files.get(path);
    const now = Date.now();
    if (append && existing) {
      const prev = existing.data ?? this.read(path);
      const merged = new Uint8Array(prev.length + data.length);
      merged.set(prev);
      merged.set(data, prev.length);
      data = merged;
    }
    this.files.set(path, { data, size: data.length, mtimeMs: now, ino: existing?.ino ?? this.inos++ });
    if (!existing) {
      this.dirs.get(dir)!.add(base(path));
      this.dirMtimes.set(dir, now);
    }
    this.emit(existing ? 'change' : 'rename', path);
  }

  mkdir(path: string, recursive = false): string | undefined {
    path = norm(path);
    if (this.dirs.has(path)) {
      if (recursive) return undefined;
      throw new FsError('EEXIST', 'mkdir', path);
    }
    if (this.files.has(path)) throw new FsError('EEXIST', 'mkdir', path);
    if (!this.dirs.has(parent(path))) {
      if (!recursive) throw new FsError('ENOENT', 'mkdir', path);
      const first = this.mkdir(parent(path), true);
      this.addDir(path);
      return first ?? path;
    }
    this.addDir(path);
    return path;
  }

  readdir(path: string): string[] {
    path = norm(path);
    const d = this.dirs.get(path);
    if (!d) throw new FsError(this.files.has(path) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
    return [...d].sort();
  }

  unlink(path: string): void {
    path = norm(path);
    if (!this.files.has(path)) throw new FsError(this.dirs.has(path) ? 'EISDIR' : 'ENOENT', 'unlink', path);
    this.files.delete(path);
    this.dirs.get(parent(path))?.delete(base(path));
    this.emit('rename', path);
  }

  rmdir(path: string, recursive = false): void {
    path = norm(path);
    const d = this.dirs.get(path);
    if (!d) throw new FsError(this.files.has(path) ? 'ENOTDIR' : 'ENOENT', 'rmdir', path);
    if (d.size && !recursive) throw new FsError('ENOTEMPTY', 'rmdir', path);
    for (const child of [...d]) {
      const p = join(path, child);
      if (this.dirs.has(p)) this.rmdir(p, true);
      else this.unlink(p);
    }
    this.dirs.delete(path);
    this.dirs.get(parent(path))?.delete(base(path));
    this.emit('rename', path);
  }

  rename(from: string, to: string): void {
    from = norm(from);
    to = norm(to);
    if (from === to) return;
    const f = this.files.get(from);
    if (f) {
      if (f.data === null) f.data = this.read(from);
      if (this.dirs.has(to)) throw new FsError('EISDIR', 'rename', to);
      if (!this.dirs.has(parent(to))) throw new FsError('ENOENT', 'rename', to);
      this.files.delete(from);
      this.dirs.get(parent(from))?.delete(base(from));
      this.files.set(to, { ...f, mtimeMs: Date.now() });
      this.dirs.get(parent(to))!.add(base(to));
      this.emit('rename', from);
      this.emit('rename', to);
      return;
    }
    if (!this.dirs.has(from)) throw new FsError('ENOENT', 'rename', from);
    this.mkdir(to, true);
    for (const child of this.readdir(from)) this.rename(join(from, child), join(to, child));
    this.rmdir(from, true);
  }

  private addDir(path: string): void {
    this.dirs.set(path, new Set());
    this.dirs.get(parent(path))?.add(base(path));
    this.dirMtimes.set(path, Date.now());
    this.emit('rename', path);
  }

  private ensureDir(path: string): void {
    if (this.dirs.has(path)) return;
    this.ensureDir(parent(path));
    this.dirs.set(path, new Set());
    this.dirs.get(parent(path))!.add(base(path));
  }

  private emit(event: 'rename' | 'change', path: string): void {
    for (const w of this.watchers) w(event, path);
  }
}

export function norm(path: string): string {
  if (!path.startsWith('/')) throw new FsError('EINVAL', 'resolve', path);
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

export function parent(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function join(a: string, b: string): string {
  return a === '/' ? `/${b}` : `${a}/${b}`;
}
