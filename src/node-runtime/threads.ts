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
import { FsError, Vfs, type VStat } from './vfs.ts';
import { adoptMailboxes, mailboxesFor, receiveMessageOnPort } from './message-ports.ts';

/** How a thread started: what its parent passed (worker.ts init message). */
export interface ThreadInit {
  id: number;
  workerData: unknown;
  env: Record<string, string>;
  argv: string[];
  /** The thread's entry script; it starts right after init (the parent may be blocked meanwhile). */
  main: string;
  /** The project's files when the thread started (see projectSnapshot), for reads while the parent is blocked. */
  snapshot?: Record<string, Uint8Array>;
  /** The mailboxes of the ports in the transfer list (see message-ports.ts). */
  mailboxes?: ReturnType<typeof mailboxesFor>;
  /** A child process (child_process.spawn/fork of node) rather than a worker thread: see child-process.ts. */
  process?: { cwd: string; execArgv: string[]; conditions: string[]; preload: string[]; ipc: boolean };
}

// --- the shared VFS ----------------------------------------------------------------------

type VfsOp = 'exists' | 'stat' | 'read' | 'write' | 'writeAt' | 'mkdir' | 'readdir' | 'unlink' | 'rmdir' | 'rename';
const HEADER = 16;
const READ_OPS = new Set<VfsOp>(['exists', 'stat', 'read', 'readdir']);
/** How long a thread waits for its parent before reading from its snapshot instead. */
const PARENT_PATIENCE_MS = 200;

/** A thread's VFS: every operation runs on the parent's VFS. */
export class RemoteVfs extends Vfs {
  private post: (msg: unknown) => void;

  constructor(post: (msg: unknown) => void) {
    super(() => {
      throw new Error('RemoteVfs does not fetch remote files itself');
    });
    this.post = post;
  }

  /**
   * Answers a read when the parent does not: it may be blocked (a WebAssembly atomic wait) until
   * this thread's work is done. `undefined` means no answer; the call keeps waiting.
   */
  protected fallback(_op: VfsOp, _args: unknown[]): { value: unknown } | undefined {
    return undefined;
  }

  /** A request the parent has not answered in time: until it does, the parent is taken to be blocked. */
  private stalled: Int32Array | null = null;

  protected call(op: VfsOp, args: unknown[]): unknown {
    if (this.stalled && Atomics.load(this.stalled, 0) === 0 && READ_OPS.has(op)) {
      const answer = this.fallback(op, args);
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
        this.stalled = header;
        const answer = READ_OPS.has(op) ? this.fallback(op, args) : undefined;
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
      return this.stat(path).kind as 'file' | 'dir';
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
  private root: string;

  constructor(post: (msg: unknown) => void, installed: Vfs, cwd: string, snapshot?: Record<string, Uint8Array>) {
    super(post);
    this.installed = installed;
    this.root = cwd;
    this.snapshot = null;
    if (snapshot) {
      const v = new Vfs(() => {
        throw new FsError('ENOENT', 'open', '');
      });
      for (const [path, data] of Object.entries(snapshot)) {
        v.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', true);
        v.write(path, data);
      }
      this.snapshot = v;
    }
  }

  /** The parent's files as of this thread's start: while the parent is blocked, they are the whole file system. */
  protected override fallback(op: VfsOp, args: unknown[]): { value: unknown } | undefined {
    const snap = this.snapshot;
    const path = String(args[0]);
    if (!snap) return undefined;
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

  private local(path: string): boolean {
    // The root's node_modules, and those of packages in it (client/, server/), the node_modules
    // directories themselves included: asked of a blocked parent, the snapshot (which leaves out
    // node_modules) would say /app/node_modules does not exist, and module resolution would skip it
    // (the Angular CLI's TypeScript thread: "Cannot find module '@angular/core'").
    return (
      path.startsWith(this.root) &&
      (path.includes('/node_modules/') || path.endsWith('/node_modules')) &&
      !/\/node_modules\/\.(vite|cache|tmp|astro|svelte-kit)/.test(path) &&
      this.installed.exists(path)
    );
  }

  override exists(path: string): boolean {
    return this.local(path) || super.exists(path);
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

/** Files a thread's snapshot leaves out: installed packages (threads read them from the host), build output, big files. */
const SNAPSHOT_SKIP = /\/(?:node_modules|\.git|\.next|\.nuxt|\.output|\.svelte-kit|\.astro|\.vinxi|\.turbo|\.cache)(?:\/|$)/;
const SNAPSHOT_MAX_FILE = 4 << 20;
const snapshots = new WeakMap<Vfs, { value: Record<string, Uint8Array> | null; off: () => void }>();

/** The project's files under `root`, for a new thread (rebuilt only after something changed). */
export function projectSnapshot(vfs: Vfs, root: string): Record<string, Uint8Array> {
  let entry = snapshots.get(vfs);
  if (!entry) {
    const e: { value: Record<string, Uint8Array> | null; off: () => void } = { value: null, off: () => {} };
    e.off = vfs.watch(() => (e.value = null));
    snapshots.set(vfs, e);
    entry = e;
  }
  if (entry.value) return entry.value;
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = vfs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      if (SNAPSHOT_SKIP.test(path)) continue;
      try {
        const st = vfs.stat(path);
        if (st.kind === 'dir') walk(path);
        else if (st.kind === 'file' && st.size <= SNAPSHOT_MAX_FILE) files[path] = vfs.read(path);
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(root);
  entry.value = files;
  return files;
}

/** Serves a thread's VFS call on this thread's VFS and wakes the thread. */
export function serveVfsCall(vfs: Vfs, msg: { sab: SharedArrayBuffer; op: VfsOp; args: unknown[] }): void {
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
  childInit(thread: ThreadInit): Record<string, unknown>;
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
  postToParent(msg: unknown, transfer?: Transferable[]): void;
  /** Messages of a nested runtime about servers it runs (listening, responses, WebSockets), which this runtime passes on. */
  relay(msg: { type: string; [k: string]: unknown }, from: globalThis.Worker): boolean;
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
 * So once a program loads worker_threads, a few runtime workers boot in advance; a new thread takes
 * one of them, which only needs its init message.
 */
const warm: globalThis.Worker[] = [];
let warmTarget = 0;
let warmBase = '';

export function warmRuntimes(base: string, count: number): void {
  warmBase = base;
  warmTarget = Math.max(warmTarget, count);
  refill();
}

function refill(): void {
  // A worker created earlier starts on its own, even if this thread is busy or blocked by then; it
  // takes its init message whenever it is ready.
  while (warm.length < warmTarget) warm.push(new globalThis.Worker(`${warmBase}/node-worker.js`));
}

export function startRuntime(host: ThreadHost, init: ThreadInit, onMessage: (m: { type: string; [k: string]: unknown }) => void, onError: (message: string) => void, transfer: Transferable[] = []): globalThis.Worker {
  const worker = warm.shift() ?? new globalThis.Worker(`${host.base()}/node-worker.js`);
  if (warmTarget) queueMicrotask(refill);
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; [k: string]: unknown };
    if (m.type === 'wt-message') adoptMailboxes(e.ports, m.mailboxes as Parameters<typeof adoptMailboxes>[1]);
    if (m.type === 'vfs-rpc') serveVfsCall(host.vfs(), m as unknown as Parameters<typeof serveVfsCall>[1]);
    else if (!host.relay(m, worker)) onMessage(m);
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    onError(e.message);
  };
  const message = host.childInit({ ...init, snapshot: projectSnapshot(host.vfs(), host.root()) });
  // The child's own port to the page's compiler, if there is one (worker.ts); last, after the
  // ports of `transfer` (their mailboxes go by position).
  worker.postMessage(message, message.compilePort ? [...transfer, message.compilePort as MessagePort] : transfer);
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

    private onChild(m: { type: string; [k: string]: unknown }) {
      switch (m.type) {
        case 'ready':
          // The thread runs its entry on its own (see ThreadInit.main).
          queueMicrotask(() => this.emit('online'));
          break;
        case 'wt-message':
          this.emit('message', m.data);
          break;
        case 'log':
          host.write(m.stream as 'stdout' | 'stderr', m.text as string);
          break;
        case 'fatal': {
          const err = new Error(String(m.message));
          if (m.stack) err.stack = String(m.stack);
          if (this.listenerCount('error')) this.emit('error', err);
          else host.write('stderr', `Uncaught (in worker ${this.threadId}) ${err.stack}\n`);
          this.finish(1);
          break;
        }
        case 'exit':
          this.finish(Number(m.code ?? 0));
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
      this.worker.postMessage({ type: 'wt-message', data: value, mailboxes: mailboxesFor(transfer) }, transfer);
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
