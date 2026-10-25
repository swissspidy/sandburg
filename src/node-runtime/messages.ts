import type { Mailbox } from './message-ports.ts';
import type { VStat } from './vfs.ts';
import type { FileTree } from '../types.ts';

/** What a runtime worker (worker.ts) posts to its host page or parent runtime. */
export type FromWorker =
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  /** ephemeral: a port the system picked (port 0), not one the program asked for (see http.ts). */
  | { type: 'listening'; port: number | string; ephemeral?: boolean }
  | { type: 'response-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'response-chunk'; id: number; chunk: Uint8Array }
  | { type: 'response-end'; id: number }
  /** A whole response (see request() in worker.ts): one message instead of start, chunks and end. */
  | { type: 'response-full'; id: number; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer }
  | { type: 'response-error'; id: number; message: string }
  | { type: 'exit'; code: number }
  /** trap: a WebAssembly trap ended a thread of this runtime (or the runtime itself, if it is a thread). */
  | { type: 'fatal'; message: string; stack?: string; trap?: boolean }
  | { type: 'ready' }
  /** The worker's script has run; it waits for init. */
  | { type: 'booted' }
  /** process.send() from the program (with init.ipc). */
  | { type: 'message'; data: unknown }
  | { type: 'ws-accept'; id: number; protocol: string; extensions: string }
  | { type: 'ws-reject'; id: number; status: number; message: string }
  | { type: 'ws-message'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-closed'; id: number; code: number; reason: string; wasClean: boolean }
  /** A command of a shell script failed, here or in a nested runtime (passed up to the host). */
  | { type: 'process-exit'; command: string; code: number; stderr: string }
  /** `unchanged`: read-tree's ifChanged, and nothing under the tracked directories changed (files is empty). */
  | { type: 'tree'; id: number; files: Record<string, string | { base64: string }>; unchanged?: boolean };

/**
 * net connections between runtimes (see net.ts): a socket here, its peer in the parent or a nested
 * runtime. A connection starts with net-connect to the runtime that has the server; then either
 * side sends data, end (half close) and close.
 */
export type NetMessage =
  | { type: 'net-connect'; id: number; key: number | string }
  | { type: 'net-connected'; id: number }
  | { type: 'net-refused'; id: number; message: string }
  | { type: 'net-data'; id: number; data: ArrayBuffer }
  | { type: 'net-end'; id: number }
  | { type: 'net-close'; id: number }
  | { type: 'net-listening'; key: number | string };

/**
 * What a runtime posts to the runtime that started it (a worker thread's or child process's parent):
 * what it would post to the page, and the messages between runtimes.
 */
export type ToParent =
  | FromWorker
  | NetMessage
  /** A request to a server this runtime does not run, for its parent to route (see loopback.route in worker.ts). */
  | { type: 'lb-request'; id: number; port: number | string; method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }
  /** From a worker thread to its Worker object in the parent (worker.postMessage's other side). */
  | { type: 'wt-message'; data: unknown; mailboxes?: (Mailbox | null)[] }
  /** A thread's synchronous file system call, answered in `sab` (see RemoteVfs and serveVfsCall in threads.ts). */
  | VfsCall;

export type VfsCall = { type: 'vfs-rpc'; sab: SharedArrayBuffer; op: VfsOp; args: unknown[] };

/** How a thread started: what its parent passed (worker.ts init message). */
export interface ThreadInit {
  id: number;
  workerData: unknown;
  env: Record<string, string>;
  argv: string[];
  /** The thread's entry script; it starts right after init (the parent may be blocked meanwhile). */
  main: string;
  /** The project's files when the thread started (see projectSnapshot): reads of them while they are unchanged, and while the parent is blocked. */
  snapshot?: ProjectSnapshot | Record<string, Uint8Array>;
  /** The mailboxes of the ports in the transfer list (see message-ports.ts). */
  mailboxes?: (Mailbox | null)[];
  /** A child process (child_process.spawn/fork of node) rather than a worker thread: see child-process.ts. */
  process?: { cwd: string; execArgv: string[]; conditions: string[]; preload: string[]; ipc: boolean };
  /** A thread (at any depth) of the app's own process, not of a child process (see WASM_CRASH_CHANNEL). */
  mainProcess?: boolean;
}

export type VfsOp = 'exists' | 'stat' | 'read' | 'write' | 'writeAt' | 'mkdir' | 'readdir' | 'unlink' | 'rmdir' | 'rename';

/**
 * The project's files as a thread starts: their bytes, and the parent's stats and directory listings
 * of everything under the project's root but caches, build output and node_modules (SNAPSHOT_SKIP),
 * and of the directories above it. `stale` is raised in shared memory once anything it covers
 * changes in the parent (a file written, made, removed or renamed, or a directory's listing): until
 * then a thread answers reads of those paths from it, as the parent would (ThreadVfs.answerExactly).
 * Installed packages are registered (Vfs.addRemote, which no watcher sees) before any thread starts.
 */
export interface ProjectSnapshot {
  root: string;
  files: Record<string, Uint8Array>;
  stats: Record<string, VStat>;
  dirs: Record<string, string[]>;
  stale: Int32Array;
}

export type ToWorker =
  | {
      type: 'init';
      cwd: string;
      env: Record<string, string>;
      files: FileTree;
      installKey: string | null;
      /** A bundle of the install's files that runs load (see adapters/node/index.ts). */
      preload?: string | null;
      /** A bundle of project files to start with (a dev server's cache from an earlier run), same format. */
      filesBundle?: string | null;
      /** Where the host records what it compiles for this run, and a bundle of what it compiled for earlier runs of the project (adapters/node/compile-cache.ts). */
      compileCache?: { key: string; bundle: string | null; token?: string } | null;
      /** Bundles the page started downloading as it started this runtime, by URL (adapters/node/process.ts, prefetchBundle). */
      prefetched?: Record<string, SharedArrayBuffer>;
      nodeModules: Record<string, number> | null;
      /** node_modules installed in the browser (npm/install.ts): shared memory and its index. */
      pack?: { sab: SharedArrayBuffer; index: Record<string, [number, number]> } | null;
      /** The preload bundle's files, as the parent runtime read them: shared memory and its index (see sharedPreload). */
      shared?: SharedPreload | null;
      /** A port to the parent's file channel (see openChannel) and its ready flag. */
      filesChannel?: { port: MessagePort; ready: SharedArrayBuffer } | null;
      /** The page's compiler (adapters/node/compile-worker.ts), for packages installed in the browser. */
      compilePort?: MessagePort | null;
      base: string;
      ipc?: boolean;
      tsRunner?: boolean;
      /** The program's node options (`node --conditions=development …`): its --conditions apply. */
      execArgv?: string[];
      /** Set when this runtime is a worker thread (worker_threads.Worker) of another. */
      thread?: ThreadInit;
      /** A thread inherits these from its parent instead of scanning files it does not have. */
      inherit?: { asyncModules: boolean; usesSqlite: boolean };
      /** Raised once anything but the install wrote in node_modules (see trackNodeModulesWrites); the main runtime's, for threads. */
      nodeModulesWrites?: Int32Array;
      /** Report large transfers to the host (src/transfer-trace.ts; dev only). */
      trace?: boolean;
    }
  /** From the parent thread to this worker thread's parentPort. */
  | { type: 'wt-message'; data: unknown; mailboxes?: (Mailbox | null)[] }
  /** `track`: project directories whose files the runtime notes changes to from now on (see read-tree's ifChanged). */
  | { type: 'run'; main: string; argv?: string[]; preload?: string[]; track?: string[] }
  /** Before init: start the spare runtimes for threads now (the page sends it as a run mounts: SPARES_AT_MOUNT in adapters/node/browser.ts). */
  | { type: 'spares' }
  /** The parent closed this child process's IPC channel. */
  | { type: 'disconnect' }
  /** A net connection between runtimes (see netMessage). */
  | NetMessage
  | { type: 'request'; id: number; port: number | string; method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }
  /** A message for the program (with init.ipc): process.on('message'). */
  | { type: 'message'; data: unknown }
  /** A WebSocket from the app frame to a virtual server (see websocket.ts). */
  /** Writes a project file, as an editor would (file watchers see the change). */
  | { type: 'write-file'; path: string; content: string }
  /**
   * The files under some directories (dev servers' caches, kept for the next run); with match, also
   * the project's files whose path matches it, outside node_modules and dot directories (an app's databases).
   */
  | { type: 'read-tree'; id: number; dirs: string[]; match?: string; ifChanged?: boolean }
  | { type: 'ws-open'; id: number; port: number; url: string; headers: [string, string][]; protocols: string[] }
  | { type: 'ws-send'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-close'; id: number; code?: number; reason?: string }
  /** The reply to a loopback request this runtime sent its parent (see loopback.route). */
  | { type: 'lb-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'lb-chunk'; id: number; chunk: ArrayBuffer }
  | { type: 'lb-end'; id: number }
  | { type: 'lb-error'; id: number; message: string; code?: string };

/**
 * The preload bundle as its runtime read it, in shared memory for the runtime's threads and child
 * processes: they read its files there instead of asking the host for each (each of rolldown's
 * WebAssembly threads asked for the same ~30 files, ~250 ms per thread). Copied from the bundle when
 * the first one starts, once per runtime; a runtime passes on what it was given.
 */
export type SharedPreload = { sab: SharedArrayBuffer; index: Record<string, [number, number]> };
