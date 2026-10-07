/** What a runtime worker (worker.ts) posts to its host page or parent runtime. */
export type FromWorker =
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  /** ephemeral: a port the system picked (port 0), not one the program asked for (see http.ts). */
  | { type: 'listening'; port: number | string; ephemeral?: boolean }
  | { type: 'response-start'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'response-chunk'; id: number; chunk: Uint8Array }
  | { type: 'response-end'; id: number }
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
  | { type: 'tree'; id: number; files: Record<string, string | { base64: string }> };
