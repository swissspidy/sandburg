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

/** Linux's signals (Node's os.constants.signals on Linux, the platform the runtime reports: no SIGBREAK, Windows' Ctrl-Break). */
export const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31 };

/**
 * Signals that leave a Node process running: ignored (Node ignores SIGPIPE), stopping (nothing ends
 * it here either), or SIGUSR1 (Node starts its inspector; the runtime has none).
 */
const NOT_ENDING = new Set(['SIGCHLD', 'SIGCONT', 'SIGURG', 'SIGWINCH', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGPIPE', 'SIGUSR1']);

/** The process's own 'warning' listener, which prints warnings (removed for --no-warnings: see worker.ts). */
export const WARNING_PRINTER = Symbol('sandburg.warningPrinter');

/** How Node's ERR_INVALID_ARG_TYPE describes the value it received. */
function received(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'object') return `an instance of ${v.constructor?.name ?? 'Object'}`;
  if (typeof v === 'function') return `function ${v.name}`;
  return `type ${typeof v} (${typeof v === 'string' ? `'${v}'` : String(v)})`;
}

/** Where a process keeps its process.setUncaughtExceptionCaptureCallback() function (see uncaught.ts). */
export const CAPTURE_CALLBACK = Symbol('sandburg.uncaughtExceptionCapture');

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
    this.done = false;
    this.due = performance.now() + this.ms;
    this.id = this.repeat ? nativeSetInterval(() => {
      this.due += this.ms;
      fn();
    }, this.ms) : nativeSetTimeout(fn, this.ms);
    byId.set(Number(this.id), this);
  }
  /** When it fires next (see takeDueTimers). */
  due = 0;
  /** Its callback, for the loop to run it as it comes due (see takeDueTimers). */
  run: () => void = () => {};
  get repeats() {
    return this.repeat;
  }
  /** A timeout the loop runs itself: the browser's timer for it no longer fires. */
  cancelNative() {
    if (this.id !== null && !this.repeat) nativeClearTimeout(this.id);
  }
  /** Scheduled and not cleared (a timeout: not fired yet; refresh() schedules it again). */
  get pending() {
    return this.id !== null && !this.done;
  }
  /** A timeout that fired. */
  private done = false;
  /** It fired (a timeout: no longer pending). */
  fired() {
    this.done = true;
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
    // While a turn of immediates is posted or going, it waits for the turn's end (see takeDueTimers).
    const t: Timeout = new Timeout(() => (turnPosted ? void dueTimers.push(t) : fire()), Math.max(1, Number(ms) || 1), repeat);
    t.run = fire;
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
  if (turnPosted || turnRunning || immediateQueue.length || closeQueue.length || ioQueue.length || nextIoQueue.length || dueTimers.length || pendingWork.count > 0) return true;
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
 * they were when it began: those queued since wait for the next iteration), then the timers that came
 * due meanwhile. Each callback is a task of its own: what it queued with process.nextTick or promises
 * runs, all of it, before the next (a browser drains its microtasks only between tasks). A timer that
 * comes due while a turn is posted waits for the turn's end, as Node's wait for the next timers phase.
 */
type Step = 'io' | 'check' | 'close';
const STEPS: Step[] = ['io', 'check', 'close'];
const queues: Record<Step, (() => void)[]> = { io: ioQueue, check: immediateQueue, close: closeQueue };
/** A turn is wanted (posted, going, or asked for while one goes): timers wait for it, and it keeps the process alive (see timersActive). */
let turnPosted = false;
/** A turn is going (its steps or its timers phase): one at a time, so a timer of it runs once. */
let turnRunning = false;
/** The message that starts the next turn is posted. */
let turnMessage = false;
/** Timers that came due while a turn was posted: they run as it ends. */
const dueTimers: Timeout[] = [];
const yieldChannel = new MessageChannel();
const yielded: (() => void)[] = [];
yieldChannel.port1.onmessage = () => yielded.shift()?.();
/** Ends this task: what the callback before queued (microtasks) runs, and the browser's other tasks. */
const nextTask = () =>
  new Promise<void>((resume) => {
    yielded.push(resume);
    yieldChannel.port2.postMessage(0);
  });
function postTurn() {
  turnPosted = true;
  // One going posts the next as it ends.
  if (turnRunning || turnMessage) return;
  turnMessage = true;
  immediateChannel.port2.postMessage(0);
}
immediateChannel.port1.onmessage = () => {
  turnMessage = false;
  void runTurn();
};
/** Runs a callback of the turn: as in Node, what it throws is uncaught (process 'uncaughtException'), and the rest still run. */
function runOne(fn: () => void) {
  try {
    fn();
  } catch (e) {
    // process.exit() reports too, and ends it there (nothing runs once it stopped).
    reportUncaught(e);
  }
}
/**
 * The timers due now, in the order they came due: those that fired while the turn went, and those
 * whose browser timer has not fired yet (it would lose to the next turn's task), which the loop runs itself.
 */
function takeDueTimers(): Timeout[] {
  const due = dueTimers.splice(0);
  const now = performance.now();
  for (const t of byId.values()) {
    if (t.repeats || t.due > now || due.includes(t)) continue;
    t.cancelNative();
    due.push(t);
  }
  return due.sort((a, b) => a.due - b.due);
}
async function runTurn() {
  turnRunning = true;
  try {
    do {
      for (const step of STEPS) {
        if (!queues[step].length) continue;
        // As libuv's closing handles, the last closed first.
        const batch = step === 'close' ? closeQueue.splice(0).reverse() : queues[step].splice(0);
        for (let i = 0; i < batch.length; i++) {
          phase = step === 'io' ? 'poll' : step;
          runOne(batch[i]);
          await nextTask();
          if (stopped) return;
        }
      }
      // What this iteration's other ends see on the next.
      ioQueue.push(...nextIoQueue.splice(0));
      // The next iteration at once, unless a timer is due (its timers phase comes first).
    } while ((ioQueue.length || immediateQueue.length || closeQueue.length) && !dueTimers.length && !byIdDue());
  } finally {
    turnPosted = false;
    // The loop's next timers phase. A timer one of them sets runs on a later one, as in Node.
    for (const timer of takeDueTimers()) {
      runOne(timer.run);
      await nextTask();
    }
    phase = 'poll';
    turnRunning = false;
    if (turnPosted || ioQueue.length || immediateQueue.length || closeQueue.length || nextIoQueue.length) postTurn();
  }
}
/** Whether a timeout has come due (its browser timer has not run it yet). */
function byIdDue(): boolean {
  const now = performance.now();
  for (const t of byId.values()) if (t.due <= now) return true;
  return false;
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
  onLaterIo(fn);
}

/**
 * Runs `fn` as an I/O callback of the loop's next iteration (a file system call's, done in the
 * thread pool): after the immediates and close callbacks this one queued, before the next one's.
 */
export function onLaterIo(fn: () => void): void {
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
  const proc = new EventEmitter() as EventEmitter & Record<string | symbol, unknown>;
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
    // As in Node: a 'warning' event on the next tick, which the process's own listener prints (a
    // program that removes the listeners prints none).
    // As Node's: a DeprecationWarning is dropped with process.noDeprecation, thrown (on the next
    // tick) with process.throwDeprecation.
    emitWarning(warning: unknown, type?: string | { type?: string; code?: string; detail?: string }, code?: string) {
      const options = typeof type === 'object' && type !== null ? type : { type, code };
      if (typeof warning !== 'string' && !(warning instanceof Error)) {
        throw Object.assign(new TypeError(`The "warning" argument must be of type string or an instance of Error. Received ${received(warning)}`), { code: 'ERR_INVALID_ARG_TYPE' });
      }
      const w = typeof warning === 'string' ? Object.assign(new Error(warning), { name: options.type || 'Warning' }) : warning;
      if (options.code !== undefined && typeof warning === 'string') Object.assign(w, { code: options.code });
      if (typeof options.detail === 'string' && typeof warning === 'string') Object.assign(w, { detail: options.detail });
      const nextTick = proc.nextTick as (fn: () => void) => void;
      if (w.name === 'DeprecationWarning') {
        if (proc.noDeprecation) return;
        if (proc.throwDeprecation) return nextTick(() => {
          throw w;
        });
      }
      nextTick(() => proc.emit('warning', w));
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
    kill(pid: unknown, signal?: unknown) {
      // As Node's (on Linux): a signal it does not know (SIGBREAK, Windows' Ctrl-Break, among them) is
      // ERR_UNKNOWN_SIGNAL. One to this process goes to its listeners; with none, one that ends a
      // process ends it, without 'exit', with exit code 128 + its number (what a shell reports for a
      // process a signal ended: there is no exit by signal here). Another process's pid is not
      // looked up: true.
      // eslint-disable-next-line eqeqeq -- as Node's check: an integer string ('42') is the pid.
      if ((pid as number) != ((pid as number) | 0)) {
        const received = typeof pid === 'string' ? `type string ('${pid}')` : typeof pid === 'number' ? `type number (${pid})` : pid == null ? String(pid) : typeof pid === 'object' ? `an instance of ${pid.constructor?.name ?? 'Object'}` : `type ${typeof pid} (${String(pid)})`;
        throw Object.assign(new TypeError(`The "pid" argument must be of type number. Received ${received}`), { code: 'ERR_INVALID_ARG_TYPE' });
      }
      let number: number;
      if (typeof signal === 'number' && signal === (signal | 0)) number = signal;
      else {
        const name = (signal || 'SIGTERM') as string;
        if (!Object.prototype.hasOwnProperty.call(SIGNALS, name)) throw Object.assign(new TypeError(`Unknown signal: ${String(name)}`), { code: 'ERR_UNKNOWN_SIGNAL' });
        number = SIGNALS[name];
      }
      const name = Object.keys(SIGNALS).find((n) => SIGNALS[n] === number);
      if (number !== 0 && !name) throw Object.assign(new Error('kill EINVAL'), { errno: -22, code: 'EINVAL', syscall: 'kill' });
      if (Number(pid) !== proc.pid || !name) return true;
      // Without a listener, the end comes at once: nothing after process.kill() runs.
      if (!proc.listenerCount(name)) {
        if (NOT_ENDING.has(name)) return true;
        throw new ExitError(128 + number);
      }
      // After the nextTick callbacks queued with it (microtasks here, see nextTick).
      queueMicrotask(() => queueMicrotask(() => proc.emit(name, name, number)));
      return true;
    },
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
    setUncaughtExceptionCaptureCallback(fn: unknown) {
      if (fn !== null && typeof fn !== 'function') {
        const received = fn === undefined ? 'undefined' : typeof fn === 'object' ? `an instance of ${fn.constructor?.name ?? 'Object'}` : `type ${typeof fn} (${typeof fn === 'string' ? `'${fn}'` : String(fn)})`;
        throw Object.assign(new TypeError(`The "fn" argument must be of type function or null. Received ${received}`), { code: 'ERR_INVALID_ARG_TYPE' });
      }
      if (fn !== null && proc[CAPTURE_CALLBACK]) {
        throw Object.assign(new Error('`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active'), { code: 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET' });
      }
      proc[CAPTURE_CALLBACK] = fn;
    },
    hasUncaughtExceptionCaptureCallback: () => !!proc[CAPTURE_CALLBACK],
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
  // Set once 'exit' is being emitted (process.exit, or an uncaught exception: see uncaught.ts), as Node's.
  Object.defineProperty(proc, '_exiting', {
    get: () => exiting,
    set: (v: unknown) => {
      exiting = !!v;
    },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(proc, CAPTURE_CALLBACK, { value: null, writable: true, enumerable: false });
  // Node's own 'warning' listener: what it prints (a program may remove it). With --trace-warnings
  // (process.traceProcessWarnings), or --trace-deprecation for a deprecation, the stack.
  let traceHint = false;
  const printer = (w: Error & { code?: string; detail?: string }) => {
    if (!(w instanceof Error)) return;
    const deprecation = w.name === 'DeprecationWarning';
    if (deprecation && proc.noDeprecation) return;
    const trace = !!proc.traceProcessWarnings || (deprecation && !!proc.traceDeprecation);
    let text = `(node:${proc.pid as number}) ${w.code ? `[${w.code}] ` : ''}${trace && w.stack ? w.stack : typeof w.toString === 'function' ? w.toString() : `${w.name}: ${w.message}`}`;
    if (typeof w.detail === 'string') text += `\n${w.detail}`;
    if (!trace && !traceHint) {
      traceHint = true;
      text += `\n(Use \`node ${deprecation ? '--trace-deprecation' : '--trace-warnings'} ...\` to show where the warning was created)`;
    }
    opts.write('stderr', `${text}\n`);
  };
  proc.on('warning', printer);
  Object.defineProperty(proc, WARNING_PRINTER, { value: printer });
  return proc;
}
