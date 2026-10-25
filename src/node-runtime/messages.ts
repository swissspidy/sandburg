import type { Mailbox } from './message-ports.ts';
import type { VfsOp } from './threads.ts';

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
