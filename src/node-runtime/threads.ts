/**
 * worker_threads for the node runtime (ADR 0012). A Worker is another
 * runtime instance in a nested Web Worker. As in Node, threads share one file
 * system: a thread's VFS calls run on its parent's VFS over a synchronous RPC
 * (SharedArrayBuffer + Atomics.wait), so files written by any thread are seen
 * by all. Messages (with SharedArrayBuffers, WebAssembly memories and
 * modules, MessagePorts) are passed as structured clones, which is what
 * WebAssembly threads (napi-rs/emnapi, used by rolldown and other Rust tools)
 * need. Shared memory needs a cross-origin isolated page.
 */
import { EventEmitter } from 'events';
import { FsError, Vfs, norm, parent, type VStat } from './vfs.ts';
import { adoptMailboxes, mailboxesFor, receiveMessageOnPort } from './message-ports.ts';
import { SPARE_NAME, SPARE_WAKE } from './names.ts';
import type { ToParent, VfsCall, ThreadInit, VfsOp, ProjectSnapshot, ToWorker } from './messages.ts';
import { allOf } from '../framework.ts';

/**
 * Where a thread of the app's own process reports a WebAssembly trap to the page directly: its
 * parent may be blocked (Atomics.wait) and never pass the crash on. process.ts listens.
 */
export const WASM_CRASH_CHANNEL = 'sandburg-wasm-thread-crash';

// --- the shared VFS ----------------------------------------------------------------------

const HEADER = 16;
const READ_OPS = new Set<VfsOp>(['exists', 'stat', 'read', 'readdir']);
/** How long a thread waits for its parent before reading from its snapshot instead. */
const PARENT_PATIENCE_MS = 200;
/**
 * How long a thread waits for its parent on a path its snapshot does not cover (a cache) before it
 * takes the parent to be blocked rather than slow, and reads its snapshot after all.
 */
const PARENT_BLOCKED_MS = 5000;

/** A thread's VFS: every operation runs on the parent's VFS. */
export class RemoteVfs extends Vfs {
  private post: (msg: VfsCall) => void;
  /** PARENT_BLOCKED_MS, unless given (tests). */
  private blockedMs: number;

  constructor(post: (msg: VfsCall) => void, blockedMs = PARENT_BLOCKED_MS) {
    super(() => {
      throw new Error('RemoteVfs does not fetch remote files itself');
    });
    this.post = post;
    this.blockedMs = blockedMs;
  }

  /**
   * Answers a read when the parent does not: it may be blocked (a WebAssembly atomic wait) until
   * this thread's work is done. `blocked`: the parent has not answered for PARENT_BLOCKED_MS, so it
   * is not merely slow. `undefined` means no answer; the call keeps waiting.
   */
  protected fallback(_op: VfsOp, _args: unknown[], _blocked: boolean): { value: unknown } | undefined {
    return undefined;
  }

  /** A request the parent has not answered in time: until it does, the parent is taken to be blocked. */
  private stalled: Int32Array | null = null;
  private stalledSince = 0;

  protected call(op: VfsOp, args: unknown[]): unknown {
    if (this.stalled && Atomics.load(this.stalled, 0) === 0 && READ_OPS.has(op)) {
      const answer = this.fallback(op, args, performance.now() - this.stalledSince >= this.blockedMs);
      if (answer) {
        if (answer.value instanceof Error) throw answer.value;
        return answer.value;
      }
    }
    let capacity = 1 << 16;
    for (;;) {
      const sab = new SharedArrayBuffer(HEADER + capacity);
      const header = new Int32Array(sab, 0, 4);
      this.post({ type: 'vfs-rpc', sab, op, args });
      if (Atomics.wait(header, 0, 0, PARENT_PATIENCE_MS) === 'timed-out') {
        if (!this.stalled || Atomics.load(this.stalled, 0) !== 0) this.stalledSince = performance.now() - PARENT_PATIENCE_MS;
        this.stalled = header;
        let answer = READ_OPS.has(op) ? this.fallback(op, args, false) : undefined;
        if (!answer && READ_OPS.has(op)) {
          const left = this.blockedMs - (performance.now() - this.stalledSince);
          if (left <= 0 || Atomics.wait(header, 0, 0, left) === 'timed-out') answer = this.fallback(op, args, true);
        }
        if (answer) {
          if (answer.value instanceof Error) throw answer.value;
          return answer.value;
        }
        Atomics.wait(header, 0, 0);
      }
      const status = header[0]; // 1 ok, 2 error, 3 needs a bigger buffer
      const length = header[1];
      if (status === 3) {
        capacity = length;
        continue;
      }
      const bytes = new Uint8Array(sab, HEADER, length).slice();
      if (status === 2) {
        const e = JSON.parse(new TextDecoder().decode(bytes)) as { code?: string; syscall?: string; path?: string; message: string };
        throw e.code ? new FsError(e.code, e.syscall ?? op, e.path ?? '') : new Error(e.message);
      }
      if (header[2] === 1) return bytes;
      return length ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    }
  }

  override addRemote(): void {}
  override watch(): () => void {
    return () => {};
  }
  override exists(path: string): boolean {
    return this.call('exists', [path]) as boolean;
  }
  override stat(path: string, syscall = 'stat'): VStat {
    return this.call('stat', [path, syscall]) as VStat;
  }
  override kind(path: string): 'file' | 'dir' | null {
    try {
      return this.stat(path).kind;
    } catch {
      return null;
    }
  }
  override read(path: string): Uint8Array {
    return this.call('read', [path]) as Uint8Array;
  }
  override write(path: string, data: Uint8Array, append = false): void {
    this.call('write', [path, data, append]);
  }
  override writeAt(path: string, data: Uint8Array, position: number | 'end'): void {
    this.call('writeAt', [path, data, position]);
  }
  override mkdir(path: string, recursive = false): string | undefined {
    return this.call('mkdir', [path, recursive]) as string | undefined;
  }
  override readdir(path: string): string[] {
    return this.call('readdir', [path]) as string[];
  }
  override unlink(path: string): void {
    this.call('unlink', [path]);
  }
  override rmdir(path: string, recursive = false): void {
    this.call('rmdir', [path, recursive]);
  }
  override rename(from: string, to: string): void {
    this.call('rename', [from, to]);
  }
}

/**
 * A thread's VFS: installed node_modules are read straight from the host (they are immutable),
 * everything else (project files, caches such as node_modules/.vite) on the parent's VFS. So a
 * thread can start and load its code while its parent is blocked (Atomics.wait), which WebAssembly
 * threads do during their start-up.
 */
export class ThreadVfs extends RemoteVfs {
  private installed: Vfs;

  private snapshot: Vfs | null;
  /** The snapshot as the parent's file system had it, while nothing it covers has changed there (see projectSnapshot). */
  private exact: ProjectSnapshot | null;
  private root: string;
  private nodeModulesWrites: Int32Array | null;

  constructor(post: (msg: VfsCall) => void, installed: Vfs, cwd: string, snapshot?: ProjectSnapshot | Record<string, Uint8Array>, nodeModulesWrites?: Int32Array, blockedMs?: number) {
    super(post, blockedMs);
    this.installed = installed;
    this.root = cwd;
    this.nodeModulesWrites = nodeModulesWrites ?? null;
    this.snapshot = null;
    this.exact = isProjectSnapshot(snapshot) ? snapshot : null;
    const files = isProjectSnapshot(snapshot) ? snapshot.files : snapshot;
    if (files) {
      const v = new Vfs(() => {
        throw new FsError('ENOENT', 'open', '');
      });
      for (const [path, data] of Object.entries(files)) {
        v.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', true);
        v.write(path, data);
      }
      this.snapshot = v;
    }
  }

  /**
   * A read of a path the snapshot covers, answered without asking the parent while nothing the
   * snapshot covers has changed there: what the parent would answer (its stats, listings and bytes
   * as of the snapshot). A thread's parent is often busy or blocked: a rolldown thread's realpath of
   * / waited 200 ms for a parent that was blocked on that thread. `undefined`: ask the parent.
   */
  private answerExactly(op: VfsOp, raw: unknown[]): { value: unknown } | undefined {
    const x = this.exact;
    if (!x || Atomics.load(x.stale, 0) !== 0) return undefined;
    const path = norm(String(raw[0]));
    if (!snapshotCovers(x.root, path)) return undefined;
    const stat = x.stats[path];
    if (op === 'exists') return { value: !!stat };
    if (op === 'stat') {
      if (!stat) throw new FsError('ENOENT', String(raw[1] ?? 'stat'), path);
      return { value: { ...stat } };
    }
    if (op === 'read') {
      if (stat?.kind === 'file') {
        const bytes = x.files[path];
        // A file too big for the snapshot: the parent has its bytes.
        return bytes ? { value: bytes.slice() } : undefined;
      }
      throw new FsError(stat ? 'EISDIR' : 'ENOENT', 'open', path);
    }
    if (op === 'readdir') {
      if (stat?.kind === 'dir') return x.dirs[path] ? { value: [...x.dirs[path]] } : undefined;
      throw new FsError(stat ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
    }
    return undefined;
  }

  protected override call(op: VfsOp, args: unknown[]): unknown {
    const answer = this.exact && READ_OPS.has(op) ? this.answerExactly(op, args) : undefined;
    return answer ? answer.value : super.call(op, args);
  }

  /** The snapshot to hand a thread this thread starts: its own, while it is exact (it covers the same files, with the same flag). */
  exactSnapshot(): ProjectSnapshot | null {
    return this.exact && Atomics.load(this.exact.stale, 0) === 0 ? this.exact : null;
  }

  /**
   * The parent's files as of this thread's start: while the parent is blocked, they answer for the
   * paths they cover. Not for the rest (installed packages aside, which local() reads from the host):
   * the snapshot leaves out caches and build output, and a parent that is only slow (a loaded
   * machine) may have just written there. Vite's dependency optimizer writes its bundle into
   * node_modules/.cache/vite from rolldown's threads; "no such directory" from the snapshot failed
   * the build.
   */
  protected override fallback(op: VfsOp, args: unknown[], blocked: boolean): { value: unknown } | undefined {
    const snap = this.snapshot;
    const path = String(args[0]);
    if (!snap || (!blocked && !this.covers(path))) return undefined;
    try {
      if (op === 'exists') return { value: snap.exists(path) };
      if (op === 'stat') return { value: snap.stat(path, String(args[1] ?? 'stat')) };
      if (op === 'read') return { value: snap.read(path) };
      const names = snap.readdir(path);
      if (this.installed.exists(`${path}/node_modules`) && !names.includes('node_modules')) names.push('node_modules');
      return { value: names };
    } catch (e) {
      return { value: e };
    }
  }

  /**
   * Whether the snapshot can answer for `path` (see projectSnapshot): project files, and the
   * node_modules directories module resolution looks for (a thread starting up while its parent is
   * blocked must not wait for those), but not caches and build output, which the parent writes.
   */
  private covers(path: string): boolean {
    if (path === this.root || path.startsWith(`${this.root}/`)) return path.endsWith('/node_modules') || !WRITTEN_DIRS.test(path);
    // Above the project, module resolution looks for node_modules and package.json up to /; the
    // app does not write there.
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const above = (d: string) => d === '/' || this.root.startsWith(`${d}/`);
    return above(path) || above(dir);
  }

  /**
   * Whether the install answers for `path`: the root's node_modules, and those of packages in it
   * (client/, server/), the node_modules directories themselves included. Asked of a blocked parent,
   * the snapshot (which leaves out node_modules) would say /app/node_modules does not exist, and
   * module resolution would skip it (the Angular CLI's TypeScript thread: "Cannot find module
   * '@angular/core'"). A path the install does not have is answered here too while nothing but the
   * install has written in node_modules (see trackNodeModulesWrites): module resolution looks for
   * many (`<package>/node_modules/<name>` for each package up the tree), and each was a round trip
   * to a parent that is often busy or blocked (a rolldown thread starting up waited 130-170 ms for
   * one).
   */
  private local(path: string): boolean {
    path = norm(path);
    if (!path.startsWith(`${this.root}/`) || !IN_NODE_MODULES.test(path) || CACHE_IN_NODE_MODULES.test(path)) return false;
    return this.installed.exists(path) || (!!this.nodeModulesWrites && Atomics.load(this.nodeModulesWrites, 0) === 0);
  }

  override exists(path: string): boolean {
    return this.local(path) ? this.installed.exists(path) : super.exists(path);
  }
  override stat(path: string, syscall = 'stat'): VStat {
    return this.local(path) ? this.installed.stat(path, syscall) : super.stat(path, syscall);
  }
  override kind(path: string): 'file' | 'dir' | null {
    return this.local(path) ? this.installed.kind(path) : super.kind(path);
  }
  override read(path: string): Uint8Array {
    return this.local(path) ? this.installed.read(path) : super.read(path);
  }
  override readdir(path: string): string[] {
    return this.local(path) ? this.installed.readdir(path) : super.readdir(path);
  }
}

/** A path in or of a node_modules directory. */
const IN_NODE_MODULES = /\/node_modules(?:\/|$)/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Caches dev servers keep in node_modules (FRAMEWORKS' nodeModulesCaches): threads always ask their parent about them. */
const NODE_MODULES_CACHES = [...allOf('nodeModulesCaches'), '.cache', '.tmp'].map(escapeRegExp).join('|');
export const CACHE_IN_NODE_MODULES = new RegExp(`/node_modules/(?:${NODE_MODULES_CACHES})`);

/**
 * A flag in shared memory that the main runtime raises once anything is written, made, renamed or
 * removed in a node_modules directory, caches aside (CACHE_IN_NODE_MODULES), apart from making a
 * directory the install has (a dev server's cache makes /app/node_modules before the install is
 * known): until then node_modules is the install (`nodeModules`, paths under `root`), and a thread
 * can tell that a path is not there without asking (ThreadVfs.local). Set up before the project's
 * files are written. Threads and child processes share their parent's file system, so their writes
 * land in the main runtime's and raise it too, before they return.
 */
export function trackNodeModulesWrites(vfs: Vfs, root: string, nodeModules: Record<string, number> | null): Int32Array {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  let dirs: Set<string> | null = null;
  const installedDir = (path: string) => {
    if (!dirs) {
      dirs = new Set();
      for (const rel of Object.keys(nodeModules ?? {})) {
        for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
          const dir = `${root}/${rel.slice(0, i)}`;
          if (dirs.has(dir)) break;
          dirs.add(dir);
        }
      }
    }
    return dirs.has(path);
  };
  vfs.watch((_event, path) => {
    if (Atomics.load(flag, 0) || !IN_NODE_MODULES.test(path) || CACHE_IN_NODE_MODULES.test(path)) return;
    if (vfs.kind(path) === 'dir' && installedDir(path)) return;
    Atomics.store(flag, 0, 1);
  });
  return flag;
}

/** Files a thread's snapshot leaves out: installed packages (threads read them from the host), build output (FRAMEWORKS' buildDirs), big files. */
const BUILD_DIRS = [...allOf('buildDirs'), '.turbo', '.cache'].map(escapeRegExp).join('|');
export const SNAPSHOT_SKIP = new RegExp(`/(?:node_modules|\\.git|${BUILD_DIRS})(?:/|$)`);
/** Caches and build output: the snapshot leaves them out, and they change while the app runs. */
export const WRITTEN_DIRS = new RegExp(`/node_modules/(?:${NODE_MODULES_CACHES})(?:/|$)|/(?:${BUILD_DIRS})(?:/|$)`);
const SNAPSHOT_MAX_FILE = 4 << 20;

function isProjectSnapshot(s: unknown): s is ProjectSnapshot {
  return !!s && (s as { stale?: unknown }).stale instanceof Int32Array;
}

/** Whether a snapshot of `root` has all there is at `path`: the root, the directories above it, and what is under it but SNAPSHOT_SKIP's. */
function snapshotCovers(root: string, path: string): boolean {
  if (path === root || (root.startsWith(path) && (path === '/' || root[path.length] === '/'))) return true;
  return path.startsWith(`${root}/`) && !SNAPSHOT_SKIP.test(path);
}

const snapshots = new WeakMap<Vfs, { value: ProjectSnapshot | null; live: Set<Int32Array>; off: () => void }>();

/** The project's files under `root`, for a new thread (rebuilt only after something changed). */
export function projectSnapshot(vfs: Vfs, root: string): ProjectSnapshot | Record<string, Uint8Array> {
  // A thread's file system is its parent's, which this thread is not told about changes to: its
  // threads get its own snapshot while that is exact, or one that only answers while the parent is blocked.
  if (vfs instanceof RemoteVfs) return (vfs instanceof ThreadVfs && vfs.exactSnapshot()) || walkProject(vfs, root).files;
  let entry = snapshots.get(vfs);
  if (!entry) {
    const e: { value: ProjectSnapshot | null; live: Set<Int32Array>; off: () => void } = { value: null, live: new Set(), off: () => {} };
    e.off = vfs.watch((_event, path) => {
      e.value = null;
      // A change to a path a snapshot covers, or to the listing of a directory it covers.
      if (e.live.size && (snapshotCovers(root, path) || snapshotCovers(root, parent(path)))) {
        for (const flag of e.live) Atomics.store(flag, 0, 1);
        e.live.clear();
      }
    });
    snapshots.set(vfs, e);
    entry = e;
  }
  if (entry.value) return entry.value;
  const snapshot = walkProject(vfs, root);
  entry.live.add(snapshot.stale);
  entry.value = snapshot;
  return snapshot;
}

function walkProject(vfs: Vfs, root: string): ProjectSnapshot {
  const files: Record<string, Uint8Array> = {};
  const stats: Record<string, VStat> = {};
  const dirs: Record<string, string[]> = {};
  const stale = new Int32Array(new SharedArrayBuffer(4));
  // The directories above the root.
  for (let at = root.lastIndexOf('/'); at >= 0; at = at === 0 ? -1 : root.lastIndexOf('/', at - 1)) {
    const dir = root.slice(0, at) || '/';
    try {
      stats[dir] = vfs.stat(dir);
      dirs[dir] = vfs.readdir(dir);
    } catch {
      // not there (yet)
    }
  }
  const walk = (dir: string) => {
    let names: string[];
    try {
      stats[dir] = vfs.stat(dir);
      names = vfs.readdir(dir);
    } catch {
      return;
    }
    dirs[dir] = names;
    for (const name of names) {
      const path = `${dir}/${name}`;
      if (SNAPSHOT_SKIP.test(path)) continue;
      try {
        const st = vfs.stat(path);
        if (st.kind === 'dir') walk(path);
        else {
          stats[path] = st;
          if (st.size <= SNAPSHOT_MAX_FILE) files[path] = vfs.read(path);
        }
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(root);
  return { root, files, stats, dirs, stale };
}

/** Serves a thread's VFS call on this thread's VFS and wakes the thread. */
export function serveVfsCall(vfs: Vfs, msg: VfsCall): void {
  const header = new Int32Array(msg.sab, 0, 4);
  const capacity = msg.sab.byteLength - HEADER;
  let status = 1;
  let kind = 0;
  let bytes: Uint8Array;
  try {
    const result = (vfs[msg.op] as (...a: unknown[]) => unknown).apply(vfs, msg.args);
    if (result instanceof Uint8Array) {
      kind = 1;
      bytes = result;
    } else bytes = result === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(result));
  } catch (e) {
    status = 2;
    const err = e as FsError;
    bytes = new TextEncoder().encode(JSON.stringify({ code: err.code, syscall: err.syscall, path: err.path, message: err.message }));
  }
  if (bytes.length > capacity) {
    header[0] = 3;
    header[1] = bytes.length;
  } else {
    new Uint8Array(msg.sab, HEADER, bytes.length).set(bytes);
    header[1] = bytes.length;
    header[2] = kind;
    header[0] = status;
  }
  Atomics.notify(header, 0);
}

// --- node:worker_threads -------------------------------------------------------------------

export interface ThreadHost {
  vfs: () => Vfs;
  /** The init message for a child runtime (install key, base, cwd). */
  childInit(thread: ThreadInit): Extract<ToWorker, { type: 'init' }>;
  /** Output of a child thread (it goes to this thread's stdout/stderr, as in Node). */
  write(stream: 'stdout' | 'stderr', text: string): void;
  cwd(): string;
  /** The project's root directory (snapshots for threads cover it). */
  root(): string;
  env(): Record<string, string>;
  resolvePath(p: string): string;
  base(): string;
  /** This thread, when it is a worker thread (for parentPort and workerData). */
  self: ThreadInit | null;
  /** Sends to this thread's parent (child side). */
  postToParent(msg: ToParent, transfer?: Transferable[]): void;
  /** Messages of a nested runtime about servers it runs (listening, responses, WebSockets), which this runtime passes on. */
  relay(msg: ToParent, from: globalThis.Worker): boolean;
  /** Ends this process with an error: a WebAssembly thread of it crashed (see Worker's 'fatal'). */
  crash(message: string, stack?: string): void;
}

/**
 * Starts a nested runtime (a worker thread or a child process) and serves its file system calls.
 * Its other messages go to `onMessage`, apart from those about servers it runs (see ThreadHost.relay).
 */
/** Nested runtimes (threads and child processes) that are running: they keep this process alive. */
export const liveRuntimes = new Set<globalThis.Worker>();

/**
 * Runtime workers started ahead of time. A browser cannot start a worker while its parent thread is
 * blocked (Atomics.wait, or a WebAssembly atomic wait), yet Rust code in WebAssembly does exactly
 * that: it blocks the calling thread and spawns threads to do the work (Tailwind's oxide scanner).
 * So once a program loads worker_threads, a few runtime workers start in advance; a new thread takes
 * one of them, which only needs its init message.
 *
 * A spare loads the runtime only when a thread takes it, on its own thread (SPARE_SCRIPT in
 * bundle.ts), or once it is woken: when a process loads node:wasi, which napi-rs WebAssembly builds
 * do before they start their threads, so that those find their runtimes ready (AWAKE_AHEAD of them).
 *
 * A parent's first messages to a new worker wait until the parent's thread has handled the worker's
 * start: Chromium holds them until the parent runs a task after the worker's script has run. So a
 * spare is no use to a parent that blocks or stays busy right after starting it; the page has the
 * program's runtime start its spares before its init message (the 'spares' message), and a program
 * that loads worker_threads starts them then.
 */
const warm: { worker: globalThis.Worker; woken: boolean }[] = [];
let warmTarget = 0;
let warmBase = '';
let awake = false;
/** How many woken spares a process keeps ready once it is awake (see wakeSpares). */
const AWAKE_AHEAD = 2;

export function warmRuntimes(base: string, count: number): void {
  warmBase = base;
  warmTarget = Math.max(warmTarget, count);
  refill();
}

/**
 * Wakes spares: they evaluate the runtime now. Not all at once: each evaluation is ~150 ms of CPU,
 * which the program's own start competes with; AWAKE_AHEAD are kept woken, the next one woken as
 * one is taken.
 */
export function wakeSpares(): void {
  if (awake) return;
  awake = true;
  wakeAhead();
}

function wakeAhead(): void {
  if (!awake) return;
  let woken = warm.filter((s) => s.woken).length;
  for (const s of warm) {
    if (woken >= AWAKE_AHEAD) break;
    if (s.woken) continue;
    s.woken = true;
    s.worker.postMessage({ type: SPARE_WAKE });
    woken++;
  }
}

function refill(): void {
  // A worker created earlier starts on its own, even if this thread is busy or blocked by then; it
  // takes its init message whenever it is ready.
  while (warm.length < warmTarget) {
    const spare = { worker: new globalThis.Worker(`${warmBase}/node-spare.js`, { name: SPARE_NAME }), woken: false };
    // One whose script failed to load is dropped: a thread gets a new runtime instead (startRuntime).
    spare.worker.onerror = (e) => {
      e.preventDefault?.();
      const i = warm.indexOf(spare);
      if (i >= 0) warm.splice(i, 1);
    };
    warm.push(spare);
  }
  wakeAhead();
}

/** A spare for a new thread: a woken one first. */
function takeSpare(): globalThis.Worker | undefined {
  const i = warm.findIndex((s) => s.woken);
  return warm.splice(i < 0 ? 0 : i, 1)[0]?.worker;
}

export function startRuntime(host: ThreadHost, init: ThreadInit, onMessage: (m: ToParent) => void, onError: (message: string) => void, transfer: Transferable[] = []): globalThis.Worker {
  const worker = takeSpare() ?? new globalThis.Worker(`${host.base()}/node-worker.js`);
  if (warmTarget) queueMicrotask(refill);
  worker.onmessage = (e: MessageEvent<ToParent>) => {
    const m = e.data;
    if (m.type === 'wt-message') adoptMailboxes(e.ports, m.mailboxes);
    if (m.type === 'vfs-rpc') serveVfsCall(host.vfs(), m);
    else if (!host.relay(m, worker)) onMessage(m);
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    onError(e.message);
  };
  const message = host.childInit({ ...init, snapshot: projectSnapshot(host.vfs(), host.root()) });
  // The child's own ports to the page's compiler and to the file channel, if there are (worker.ts);
  // last, after the ports of `transfer` (their mailboxes go by position).
  const ports = [message.compilePort, message.filesChannel?.port].filter((p): p is MessagePort => !!p);
  worker.postMessage(message, [...transfer, ...ports]);
  liveRuntimes.add(worker);
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    liveRuntimes.delete(worker);
    terminate();
  };
  return worker;
}

let nextThreadId = 1;
const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

export function createWorkerThreads(host: ThreadHost) {
  class Worker extends EventEmitter {
    readonly threadId: number;
    readonly resourceLimits = {};
    private worker: globalThis.Worker;
    private exited = false;
    stdin = null;
    stdout: EventEmitter;
    stderr: EventEmitter;

    constructor(filename: string | URL, options: { workerData?: unknown; env?: Record<string, string> | symbol; eval?: boolean; argv?: unknown[]; execArgv?: string[]; transferList?: Transferable[]; name?: string } = {}) {
      super();
      this.threadId = nextThreadId++ + (host.self ? host.self.id * 1000 : 0);
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      let main: string;
      if (options.eval) {
        main = `${host.cwd()}/.sandburg/worker-eval-${this.threadId}.js`;
        host.vfs().mkdir(main.slice(0, main.lastIndexOf('/')), true);
        host.vfs().write(main, new TextEncoder().encode(String(filename)));
      } else {
        const f = filename instanceof URL ? filename.href : String(filename);
        main = f.startsWith('file:') ? decodeURIComponent(new URL(f).pathname) : host.resolvePath(f);
      }
      const env = options.env === SHARE_ENV || options.env === undefined ? host.env() : (options.env as Record<string, string>);
      const thread: ThreadInit = { id: this.threadId, workerData: options.workerData, env: { ...env }, argv: (options.argv ?? []).map(String), main, mailboxes: mailboxesFor(options.transferList) };
      this.worker = startRuntime(
        host,
        thread,
        (m) => this.onChild(m),
        (message) => {
          this.emit('error', new Error(message));
          this.finish(1);
        },
        options.transferList ?? [],
      );
    }

    private onChild(m: ToParent) {
      switch (m.type) {
        case 'ready':
          // The thread runs its entry on its own (see ThreadInit.main).
          queueMicrotask(() => this.emit('online'));
          break;
        case 'wt-message':
          this.emit('message', m.data);
          break;
        case 'log':
          host.write(m.stream, m.text);
          break;
        case 'fatal': {
          // A WebAssembly trap (memory access out of bounds, a Rust panic) in a thread leaves the
          // module's shared memory, and the threads waiting on it, in a state nothing can resume:
          // rolldown waits forever for a crashed thread's work. Natively that is a segfault or an
          // abort, which ends the process, so the process ends here too.
          if (m.trap) {
            const crashed = /^a WebAssembly thread crashed/.test(m.message);
            host.crash(crashed ? m.message : `a WebAssembly thread crashed (worker ${this.threadId}): RuntimeError: ${m.message}`, m.stack);
          }
          const err = new Error(m.message);
          if (m.stack) err.stack = m.stack;
          if (this.listenerCount('error')) this.emit('error', err);
          else host.write('stderr', `Uncaught (in worker ${this.threadId}) ${err.stack}\n`);
          this.finish(1);
          break;
        }
        case 'exit':
          // An app may exit with a string (process.exit('1')).
          this.finish(Number(m.code ?? 0));
          break;
        // Its servers' messages are relayed (ThreadHost.relay); the rest are not a thread's.
        default:
          break;
      }
    }

    private finish(code: number) {
      if (this.exited) return;
      this.exited = true;
      this.worker.terminate();
      this.emit('exit', code);
    }

    postMessage(value: unknown, transferList?: Transferable[] | { transfer?: Transferable[] }) {
      const transfer = Array.isArray(transferList) ? transferList : (transferList?.transfer ?? []);
      this.worker.postMessage({ type: 'wt-message', data: value, mailboxes: mailboxesFor(transfer) } satisfies ToWorker, transfer);
    }

    terminate(): Promise<number> {
      this.finish(1);
      return Promise.resolve(1);
    }

    ref() {
      return this;
    }
    // A thread keeps its process alive even when unref'd: napi-rs unrefs its WebAssembly threads, and in
    // Node their pending async work keeps the event loop alive instead, which this runtime cannot see.
    unref() {
      return this;
    }
    getHeapSnapshot(): never {
      throw new Error('worker.getHeapSnapshot() is not supported in the browser runtime');
    }
  }

  /** The thread's end of its parent's channel. Like a MessagePort, it holds messages until someone listens. */
  class ParentPort extends EventEmitter {
    private queue: unknown[] | null = [];
    constructor() {
      super();
      this.on('newListener', (event: string) => {
        if (event !== 'message' || !this.queue) return;
        const queued = this.queue;
        this.queue = null;
        queueMicrotask(() => queued.forEach((m) => this.emit('message', m)));
      });
    }
    receive(data: unknown) {
      if (this.queue) this.queue.push(data);
      else this.emit('message', data);
    }
    postMessage(value: unknown, transferList?: Transferable[] | { transfer?: Transferable[] }) {
      const transfer = Array.isArray(transferList) ? transferList : (transferList?.transfer ?? []);
      host.postToParent({ type: 'wt-message', data: value, mailboxes: mailboxesFor(transfer) }, transfer);
    }
    start() {}
    close() {}
    ref() {
      return this;
    }
    unref() {
      return this;
    }
  }
  const parentPort = host.self ? new ParentPort() : null;

  return {
    module: {
      isMainThread: !host.self,
      isInternalThread: false,
      parentPort,
      workerData: host.self?.workerData ?? null,
      threadId: host.self?.id ?? 0,
      resourceLimits: {},
      SHARE_ENV,
      Worker,
      // The runtime's MessageChannel (see message-ports.ts), installed when the runtime starts.
      get MessageChannel() {
        return globalThis.MessageChannel;
      },
      MessagePort,
      BroadcastChannel,
      markAsUntransferable: () => {},
      isMarkedAsUntransferable: () => false,
      markAsUncloneable: () => {},
      moveMessagePortToContext: (p: unknown) => p,
      receiveMessageOnPort,
      getEnvironmentData: () => undefined,
      setEnvironmentData: () => {},
    },
    /** Delivers a message from the parent to this thread's parentPort. */
    deliver(data: unknown) {
      parentPort?.receive(data);
    },
  };
}
