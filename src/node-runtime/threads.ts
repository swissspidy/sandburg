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

/** How a thread started: what its parent passed (worker.ts init message). */
export interface ThreadInit {
  id: number;
  workerData: unknown;
  env: Record<string, string>;
  argv: string[];
  /** The thread's entry script; it starts right after init (the parent may be blocked meanwhile). */
  main: string;
  /** A child process (child_process.spawn/fork of node) rather than a worker thread: see child-process.ts. */
  process?: { cwd: string; execArgv: string[]; conditions: string[]; preload: string[]; ipc: boolean };
}

// --- the shared VFS ----------------------------------------------------------------------

type VfsOp = 'exists' | 'stat' | 'read' | 'write' | 'mkdir' | 'readdir' | 'unlink' | 'rmdir' | 'rename';
const HEADER = 16;

/** A thread's VFS: every operation runs on the parent's VFS. */
export class RemoteVfs extends Vfs {
  private post: (msg: unknown) => void;

  constructor(post: (msg: unknown) => void) {
    super(() => {
      throw new Error('RemoteVfs does not fetch remote files itself');
    });
    this.post = post;
  }

  private call(op: VfsOp, args: unknown[]): unknown {
    let capacity = 1 << 16;
    for (;;) {
      const sab = new SharedArrayBuffer(HEADER + capacity);
      const header = new Int32Array(sab, 0, 4);
      this.post({ type: 'vfs-rpc', sab, op, args });
      Atomics.wait(header, 0, 0);
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
  override read(path: string): Uint8Array {
    return this.call('read', [path]) as Uint8Array;
  }
  override write(path: string, data: Uint8Array, append = false): void {
    this.call('write', [path, data, append]);
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
  private nm: string;

  constructor(post: (msg: unknown) => void, installed: Vfs, cwd: string) {
    super(post);
    this.installed = installed;
    this.nm = `${cwd}/node_modules/`;
  }

  private local(path: string): boolean {
    return path.startsWith(this.nm) && !/\/node_modules\/\.(vite|cache|tmp|astro|svelte-kit)/.test(path) && this.installed.exists(path);
  }

  override exists(path: string): boolean {
    return this.local(path) || super.exists(path);
  }
  override stat(path: string, syscall = 'stat'): VStat {
    return this.local(path) ? this.installed.stat(path, syscall) : super.stat(path, syscall);
  }
  override read(path: string): Uint8Array {
    return this.local(path) ? this.installed.read(path) : super.read(path);
  }
  override readdir(path: string): string[] {
    return this.local(path) ? this.installed.readdir(path) : super.readdir(path);
  }
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

export function startRuntime(host: ThreadHost, init: ThreadInit, onMessage: (m: { type: string; [k: string]: unknown }) => void, onError: (message: string) => void, transfer: Transferable[] = []): globalThis.Worker {
  const worker = new globalThis.Worker(`${host.base()}/node-worker.js`);
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; [k: string]: unknown };
    if (m.type === 'vfs-rpc') serveVfsCall(host.vfs(), m as unknown as Parameters<typeof serveVfsCall>[1]);
    else if (!host.relay(m, worker)) onMessage(m);
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    onError(e.message);
  };
  worker.postMessage(host.childInit(init), transfer);
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
      const thread: ThreadInit = { id: this.threadId, workerData: options.workerData, env: { ...env }, argv: (options.argv ?? []).map(String), main };
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
      this.worker.postMessage({ type: 'wt-message', data: value }, transfer);
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
      host.postToParent({ type: 'wt-message', data: value }, transfer);
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
      MessageChannel,
      MessagePort,
      BroadcastChannel,
      markAsUntransferable: () => {},
      isMarkedAsUntransferable: () => false,
      markAsUncloneable: () => {},
      moveMessagePortToContext: (p: unknown) => p,
      receiveMessageOnPort: () => undefined,
      getEnvironmentData: () => undefined,
      setEnvironmentData: () => {},
    },
    /** Delivers a message from the parent to this thread's parentPort. */
    deliver(data: unknown) {
      parentPort?.receive(data);
    },
  };
}
