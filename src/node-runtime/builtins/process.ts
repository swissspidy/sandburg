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

/** Signals whose default action leaves a process running (ignored, or it stops: nothing ends it here either). */
const NOT_ENDING = new Set(['SIGCHLD', 'SIGCONT', 'SIGURG', 'SIGWINCH', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU']);

/** Where a process keeps its process.setUncaughtExceptionCaptureCallback() function (see uncaught.ts). */
export const CAPTURE_CALLBACK = Symbol('sandburg.uncaughtExceptionCapture');

// --- timers ---------------------------------------------------------------------

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

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
    this.id = this.repeat ? nativeSetInterval(this.fn, this.ms) : nativeSetTimeout(this.fn, this.ms);
    byId.set(Number(this.id), this);
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

const byId = new Map<number, Timeout>();
/** The process exited: nothing it scheduled runs any more (see stopTimers). */
let stopped = false;
function make(repeat: boolean) {
  return (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const bound = bindContext(fn as never) as (...a: unknown[]) => void;
    const t: Timeout = new Timeout(() => {
      if (!repeat) t.fired();
      if (stopped) return t.clear();
      bound(...args);
    }, Math.max(1, Number(ms) || 1), repeat);
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
  if (immediateQueue.length || pendingWork.count > 0) return true;
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
}

class Immediate {
  cancelled = false;
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
const immediateChannel = new MessageChannel();
const immediateQueue: (() => void)[] = [];
immediateChannel.port1.onmessage = () => {
  const batch = immediateQueue.splice(0);
  for (let i = 0; i < batch.length; i++) {
    try {
      batch[i]();
    } catch (e) {
      // As in Node: the error is uncaught (process 'uncaughtException'), and the rest of the batch
      // still runs, on the next turn, before immediates queued since; process.exit() ends it there.
      if (!(e instanceof ExitError) && i + 1 < batch.length) {
        if (!immediateQueue.length) immediateChannel.port2.postMessage(0);
        immediateQueue.unshift(...batch.slice(i + 1));
      }
      throw e;
    }
  }
};

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
    if (immediateQueue.length === 1) immediateChannel.port2.postMessage(0);
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
    emitWarning(warning: string | Error, type?: string | { type?: string; code?: string; detail?: string }, code?: string) {
      const options = typeof type === 'object' && type !== null ? type : { type, code };
      const w = typeof warning === 'string' ? Object.assign(new Error(warning), { name: options.type ?? 'Warning' }) : warning;
      if (options.code !== undefined && typeof warning === 'string') Object.assign(w, { code: options.code });
      if (options.detail !== undefined && typeof warning === 'string') Object.assign(w, { detail: options.detail });
      (proc.nextTick as (fn: () => void) => void)(() => proc.emit('warning', w));
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
      // After the nextTick callbacks queued with it (microtasks here, see nextTick).
      queueMicrotask(() =>
        queueMicrotask(() => {
          if (proc.listenerCount(name)) proc.emit(name, name, number);
          else if (!NOT_ENDING.has(name)) throw new ExitError(128 + number);
        }),
      );
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
  // Node's own 'warning' listener: what it prints (a program may remove it).
  let traceHint = false;
  proc.on('warning', (w: Error & { code?: string; detail?: string }) => {
    let text = `(node:${proc.pid as number}) ${w.code ? `[${w.code}] ` : ''}${typeof w.toString === 'function' ? w.toString() : `${w.name}: ${w.message}`}`;
    if (typeof w.detail === 'string') text += `\n${w.detail}`;
    if (!traceHint) {
      traceHint = true;
      text += '\n(Use `node --trace-warnings ...` to show where the warning was created)';
    }
    opts.write('stderr', `${text}\n`);
  });
  return proc;
}
