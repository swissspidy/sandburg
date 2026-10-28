/**
 * node:process and node:timers for the runtime. Reports Node.js 24 on
 * linux/x64; stdout and stderr go to the host page. Timers return Node-style
 * Timeout objects (ref/unref/refresh) and carry async context.
 */
import { EventEmitter } from 'events';
import { Readable, Writable } from 'readable-stream';
import { bindContext } from '../async-context.ts';

import { NODE_VERSION } from '../version.ts';

export { NODE_VERSION };

export class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitError';
    this.code = code;
  }
}

// --- timers ---------------------------------------------------------------------

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
/** Reports an error as uncaught (the worker's 'error' event), as one thrown from a task would be. */
const reportUncaught = globalThis.reportError?.bind(globalThis) ?? ((e: unknown) => queueMicrotask(() => { throw e; }));

class Timeout {
  private id: ReturnType<typeof nativeSetTimeout> | null = null;
  private refed = true;
  private fn: () => void;
  private ms: number;
  private repeat: boolean;
  constructor(fn: () => void, ms: number, repeat: boolean) {
    this.fn = fn;
    this.ms = ms;
    this.repeat = repeat;
    this.start();
  }
  /** Scheduled, and pending (in byId) until it fires or is cleared; a refresh() after it fired schedules it again. */
  private start() {
    const fn = this.fn;
    this.due = performance.now() + this.ms;
    this.id = this.repeat ? nativeSetInterval(() => {
      this.due += this.ms;
      fn();
    }, this.ms) : nativeSetTimeout(fn, this.ms);
    byId.set(Number(this.id), this);
  }
  /** When it fires next (see timerDue). */
  due = 0;
  /** Scheduled and not cleared (a timeout: not fired yet). */
  get pending() {
    return this.id !== null;
  }
  /** It fired (a timeout: no longer pending). */
  fired() {
    if (this.id !== null) byId.delete(Number(this.id));
  }
  clear() {
    if (this.id === null) return;
    byId.delete(Number(this.id));
    (this.repeat ? nativeClearInterval : nativeClearTimeout)(this.id);
    this.id = null;
  }
  ref() {
    this.refed = true;
    return this;
  }
  unref() {
    this.refed = false;
    return this;
  }
  hasRef() { return this.refed; }
  /** Whether it keeps the process alive (see activeHandles). */
  get alive() {
    return this.refed && this.id !== null;
  }
  refresh() {
    this.clear();
    this.start();
    return this;
  }
  close() {
    this.clear();
    return this;
  }
  [Symbol.toPrimitive]() {
    return Number(this.id ?? 0);
  }
  [Symbol.dispose]() {
    this.clear();
  }
}

/**
 * The phase of libuv's loop the program's code runs in, as far as it decides what a connection's other
 * end sees when (see onPeerPhase): a timer's callback (and what it queued), an immediate, a close
 * callback, else I/O ('poll': messages, fetches).
 */
type Phase = 'timers' | 'poll' | 'check' | 'close';
let phase: Phase = 'poll';
const toPoll = () => void (phase = 'poll');

const byId = new Map<number, Timeout>();
/** The process exited: nothing it scheduled runs any more (see stopTimers). */
let stopped = false;
function make(repeat: boolean) {
  return (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const bound = bindContext(fn as never) as (...a: unknown[]) => void;
    const fire = () => {
      // Cleared while it waited for a turn to end (see dueTimers).
      if (!t.pending) return;
      if (!repeat) t.fired();
      if (stopped) return t.clear();
      phase = 'timers';
      try {
        bound(...args);
      } finally {
        // What it queued (process.nextTick, promises) still runs in it.
        queueMicrotask(toPoll);
      }
    };
    const t: Timeout = new Timeout(() => (turnRunning ? dueTimers.push(fire) : fire()), Math.max(1, Number(ms) || 1), repeat);
    return t;
  };
}
function clear(t: unknown) {
  if (t instanceof Timeout) t.clear();
  else if (typeof t === 'number') {
    const found = byId.get(t);
    if (found) found.clear();
    else nativeClearTimeout(t);
  }
}

/**
 * Whether anything scheduled keeps the process alive: ref'd timers, immediates, and async work
 * others report (in-flight fetches, see `pendingWork`). Used to end child processes whose event loop
 * has drained, as Node does.
 */
export const pendingWork = { count: 0 };
export function timersActive(): boolean {
  if (turnPosted || immediateQueue.length || closeQueue.length || ioQueue.length || nextIoQueue.length || dueTimers.length || pendingWork.count > 0) return true;
  for (const t of byId.values()) if (t.alive) return true;
  return false;
}

/**
 * The process exited (process.exit): its timers and immediates, and any it sets after, do not run.
 * A known limit: a shell this runtime runs in-process (child_process with shell: true, see shell.ts)
 * uses these timers too, and stops with it, where in Node it is a process of its own that goes on.
 */
export function stopTimers(): void {
  stopped = true;
  for (const t of [...byId.values()]) t.clear();
  immediateQueue.length = 0;
  closeQueue.length = 0;
  ioQueue.length = 0;
  nextIoQueue.length = 0;
  dueTimers.length = 0;
}

class Immediate {
  cancelled = false;
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
const immediateChannel = new MessageChannel();
const immediateQueue: (() => void)[] = [];
/** What runs as Node's close callbacks do (see onClosePhase): after the immediates of the same turn. */
const closeQueue: (() => void)[] = [];
/** What runs as I/O callbacks do (see onIoPhase): on the next turn, before its immediates. */
const ioQueue: (() => void)[] = [];
/** I/O for the loop's next iteration, after this one's close callbacks (see onPeerPhase), in the order it came. */
const nextIoQueue: (() => void)[] = [];
/**
 * A turn of the loop: its I/O callbacks, then its immediates, then its close callbacks (each step's as
 * they were when it began: those queued since wait for the next turn). It is one task: a timer that
 * comes due meanwhile waits for its end, as Node's wait for the loop's next timers phase. Between two
 * callbacks, what the first queued with process.nextTick or promises runs (see settle), as in Node.
 */
type Step = 'io' | 'check' | 'close';
const STEPS: Step[] = ['io', 'check', 'close'];
const queues: Record<Step, (() => void)[]> = { io: ioQueue, check: immediateQueue, close: closeQueue };
/** A turn is posted or going (it keeps the process alive: see timersActive). */
let turnPosted = false;
let turnRunning = false;
/** Timers that came due during a turn: they run as it ends. */
const dueTimers: (() => void)[] = [];
/**
 * How long a turn runs before it lets the browser in (a message, a timer, then the rest of the turn):
 * a huge batch of immediates does not hold the runtime for its whole length.
 */
const TURN_BUDGET_MS = 100;
/** Microtask hops after a callback: what it queued (and what that queued, to this depth) runs before the next. */
const SETTLE_HOPS = 4;
const RESOLVED = Promise.resolve();
const yieldChannel = new MessageChannel();
const yielded: (() => void)[] = [];
yieldChannel.port1.onmessage = () => yielded.shift()?.();
function postTurn() {
  if (turnPosted) return;
  turnPosted = true;
  immediateChannel.port2.postMessage(0);
}
immediateChannel.port1.onmessage = () => void runTurn();
/** Runs a callback of the turn: as in Node, what it throws is uncaught (process 'uncaughtException'), and the rest still run. */
function runOne(fn: () => void) {
  try {
    fn();
  } catch (e) {
    // process.exit() reports too, and ends it there (nothing runs once it stopped).
    reportUncaught(e);
  }
}
/** Whether a timer has come due (its callback waits for the browser to run it). */
function timerDue(): boolean {
  const now = performance.now();
  for (const t of byId.values()) if (t.due <= now) return true;
  return false;
}
/** How long a turn goes on into the loop's next iteration (no timer due), instead of a task of its own. */
const TURN_CONTINUE_MS = 4;
async function runTurn() {
  turnRunning = true;
  const start = performance.now();
  let since = start;
  try {
    do {
      for (const step of STEPS) {
        if (!queues[step].length) continue;
        phase = step === 'io' ? 'poll' : step;
        // As libuv's closing handles, the last closed first.
        const batch = step === 'close' ? closeQueue.splice(0).reverse() : queues[step].splice(0);
        for (let i = 0; i < batch.length; i++) {
          runOne(batch[i]);
          // What it queued runs before the next (to SETTLE_HOPS deep).
          for (let hop = 0; hop < SETTLE_HOPS; hop++) await RESOLVED;
          if (stopped) return;
          if (performance.now() - since > TURN_BUDGET_MS && i + 1 < batch.length) {
            await new Promise<void>((resume) => {
              yielded.push(resume);
              yieldChannel.port2.postMessage(0);
            });
            since = performance.now();
            phase = step === 'io' ? 'poll' : step;
          }
        }
      }
      // What this iteration's other ends see on the next.
      ioQueue.push(...nextIoQueue.splice(0));
    } while (performance.now() - start < TURN_CONTINUE_MS && (ioQueue.length || immediateQueue.length || closeQueue.length) && !dueTimers.length && !timerDue());
  } finally {
    turnRunning = false;
    turnPosted = false;
    phase = 'poll';
    // The loop's next timers phase: those that came due during the turn.
    for (const timer of dueTimers.splice(0)) {
      runOne(timer);
      for (let hop = 0; hop < SETTLE_HOPS; hop++) await RESOLVED;
    }
    phase = 'poll';
    if (ioQueue.length || immediateQueue.length || closeQueue.length || nextIoQueue.length) postTurn();
  }
}

/**
 * Runs `fn` as libuv runs a closed handle's callback (a socket's 'close'): after what process.nextTick,
 * promises and setImmediate queued before it in this turn, before the timers of the next.
 */
export function onClosePhase(fn: () => void): void {
  closeQueue.push(() => {
    if (!stopped) fn();
  });
  postTurn();
}

/** Runs `fn` as libuv runs an I/O callback: on the next turn, before the immediates queued until then. */
function onIoPhase(fn: () => void): void {
  ioQueue.push(() => {
    if (!stopped) fn();
  });
  postTurn();
}

/**
 * Runs `fn` as the other end of a connection in this process sees what this end did now (its data,
 * end or reset): in libuv's next poll phase. In a timer's callback that is the same loop iteration's,
 * before the immediates and close callbacks this turn queued; else the next iteration's, after them.
 */
export function onPeerPhase(fn: () => void): void {
  if (phase === 'timers') return onIoPhase(fn);
  nextIoQueue.push(() => {
    if (!stopped) fn();
  });
  postTurn();
}

export const timers = {
  setTimeout: make(false),
  setInterval: make(true),
  clearTimeout: clear,
  clearInterval: clear,
  setImmediate(fn: (...args: unknown[]) => void, ...args: unknown[]) {
    const bound = bindContext(fn as never) as (...a: unknown[]) => void;
    const imm = new Immediate();
    immediateQueue.push(() => {
      if (!imm.cancelled && !stopped) bound(...args);
    });
    postTurn();
    return imm;
  },
  clearImmediate(imm: unknown) {
    if (imm instanceof Immediate) imm.cancelled = true;
  },
};

export const timersPromises = {
  setTimeout: (ms?: number, value?: unknown) => new Promise((r) => timers.setTimeout(() => r(value), ms)),
  setImmediate: (value?: unknown) => new Promise((r) => timers.setImmediate(() => r(value))),
  async *setInterval(ms?: number, value?: unknown) {
    for (;;) {
      await new Promise((r) => timers.setTimeout(r, ms));
      yield value;
    }
  },
  scheduler: { wait: (ms: number) => new Promise((r) => timers.setTimeout(r, ms)), yield: () => new Promise((r) => timers.setImmediate(r)) },
};

// --- process ----------------------------------------------------------------------

export interface ProcessOptions {
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  write(stream: 'stdout' | 'stderr', text: string): void;
  /** When set, the process has an IPC channel (process.send), as a child forked with one does. */
  send?(message: unknown): void;
  /** What stdin reads (a synchronous child process's `input`); otherwise it is empty. */
  stdin?: Uint8Array;
}

function stdinStream(input?: Uint8Array): Readable {
  let left = input?.length ? Buffer.from(input) : null;
  return new Readable({
    read() {
      if (left) this.push(left);
      left = null;
      this.push(null);
    },
  });
}

export function createProcess(opts: ProcessOptions) {
  let cwd = opts.cwd;
  let exiting = false;
  const t0 = performance.now();
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const out = (name: 'stdout' | 'stderr') => {
    const w = new Writable({
      write(chunk, _enc, cb) {
        opts.write(name, typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        cb();
      },
    });
    return Object.assign(w, { isTTY: false, columns: 120, rows: 40, fd: name === 'stdout' ? 1 : 2, getColorDepth: () => 1, hasColors: () => false, cursorTo() {}, clearLine() {}, moveCursor() {} });
  };
  const hrtime = (prev?: [number, number]) => {
    const ns = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
    const s = Number(ns / 1_000_000_000n);
    const n = Number(ns % 1_000_000_000n);
    if (!prev) return [s, n];
    let ds = s - prev[0];
    let dn = n - prev[1];
    if (dn < 0) {
      ds--;
      dn += 1e9;
    }
    return [ds, dn];
  };
  hrtime.bigint = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const memory = () => {
    const heap = performance.memory;
    const used = heap?.usedJSHeapSize ?? 64e6;
    return { rss: used * 1.5, heapTotal: heap?.totalJSHeapSize ?? used * 1.2, heapUsed: used, external: 0, arrayBuffers: 0 };
  };
  const memoryUsage = Object.assign(memory, { rss: () => memory().rss });

  Object.assign(proc, {
    title: 'node',
    version: `v${NODE_VERSION}`,
    versions: { node: NODE_VERSION, v8: '13.6.233.10-node.24', uv: '1.51.0', zlib: '1.3.1', modules: '137', napi: '10', openssl: '3.0.15', unicode: '16.0' },
    release: { name: 'node', lts: 'Krypton' },
    arch: 'x64',
    platform: 'linux',
    pid: 42,
    ppid: 1,
    execPath: '/usr/local/bin/node',
    execArgv: [],
    argv: opts.argv,
    argv0: 'node',
    env: opts.env,
    config: { variables: { napi_build_version: '10' } },
    features: { inspector: false, ipv6: true, tls: false, typescript: 'strip' },
    allowedNodeEnvironmentFlags: new Set<string>(),
    stdout: out('stdout'),
    stderr: out('stderr'),
    stdin: Object.assign(stdinStream(opts.stdin), { isTTY: false, fd: 0, setRawMode() {} }),
    cwd: () => cwd,
    chdir: (dir: string) => {
      cwd = dir.startsWith('/') ? dir : `${cwd}/${dir}`;
    },
    umask: () => 0o022,
    getuid: () => 0,
    geteuid: () => 0,
    getgid: () => 0,
    getegid: () => 0,
    getgroups: () => [0],
    uptime: () => (performance.now() - t0) / 1000,
    hrtime,
    memoryUsage,
    cpuUsage: () => ({ user: Math.round(performance.now() * 1000), system: 0 }),
    resourceUsage: () => ({ maxRSS: memory().rss / 1024 }),
    constrainedMemory: () => 0,
    availableMemory: () => 4e9,
    nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]) {
      const bound = bindContext(fn as never) as (...a: unknown[]) => void;
      queueMicrotask(() => bound(...args));
    },
    ...(opts.send
      ? {
          connected: true,
          send(message: unknown, ...rest: unknown[]) {
            opts.send!(JSON.parse(JSON.stringify(message)));
            const cb = rest.find((a) => typeof a === 'function') as (() => void) | undefined;
            if (cb) queueMicrotask(cb);
            return true;
          },
          disconnect() {
            proc.connected = false;
          },
        }
      : {}),
    emitWarning(warning: string | Error, type?: string | { type?: string }) {
      const text = typeof warning === 'string' ? warning : warning.message;
      const name = typeof type === 'string' ? type : (type?.type ?? 'Warning');
      opts.write('stderr', `(node) ${name}: ${text}\n`);
    },
    exit(...args: [code?: number | string | null]) {
      // As in Node: 'exit' listeners see the code as process.exitCode (and may change it); one that
      // calls process.exit() ends the process there, with its code, without emitting 'exit' again.
      // process.exit(undefined) is process.exit(0), whatever exitCode was.
      if (args.length) proc.exitCode = args[0];
      if (!exiting) {
        exiting = true;
        proc.emit('exit', Number(proc.exitCode ?? 0));
      }
      throw new ExitError(Number(proc.exitCode ?? 0));
    },
    reallyExit(code: number) {
      throw new ExitError(code);
    },
    abort() {
      throw new ExitError(134);
    },
    kill: () => true,
    binding(name: string) {
      throw new Error(`No such module: ${name}`);
    },
    _linkedBinding(name: string) {
      throw new Error(`No such binding: ${name}`);
    },
    dlopen(_m: unknown, filename: string) {
      throw new Error(`native addons cannot be loaded in the browser runtime: ${filename}`);
    },
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.36' }, sharedObjects: [] }) },
    setSourceMapsEnabled() {},
    sourceMapsEnabled: false,
    getActiveResourcesInfo: () => [],
    setUncaughtExceptionCaptureCallback() {},
    hasUncaughtExceptionCaptureCallback: () => false,
    loadEnvFile() {},
  });
  // As in Node: an integer string ('2') is the number.
  let exitCode: number | undefined;
  Object.defineProperty(proc, 'exitCode', {
    get: () => exitCode,
    set: (code: unknown) => {
      exitCode = code === null || code === undefined ? undefined : typeof code === 'string' && code !== '' && Number.isInteger(+code) ? +code : (code as number);
    },
    enumerable: true,
    configurable: true,
  });
  return proc;
}
