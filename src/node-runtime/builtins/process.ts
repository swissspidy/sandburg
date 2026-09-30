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
  private start() {
    this.id = this.repeat ? nativeSetInterval(this.fn, this.ms) : nativeSetTimeout(this.fn, this.ms);
  }
  clear() {
    if (this.id === null) return;
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
function make(repeat: boolean) {
  return (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const bound = bindContext(fn as never) as (...a: unknown[]) => void;
    const t: Timeout = new Timeout(() => {
      if (!repeat) byId.delete(Number(t));
      bound(...args);
    }, Math.max(1, Number(ms) || 1), repeat);
    byId.set(Number(t), t);
    return t;
  };
}
function clear(t: unknown) {
  if (t instanceof Timeout) {
    byId.delete(Number(t));
    t.clear();
  } else if (typeof t === 'number') {
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
  for (const run of batch) run();
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
      if (!imm.cancelled) bound(...args);
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
}

export function createProcess(opts: ProcessOptions) {
  let cwd = opts.cwd;
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
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
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
    exitCode: undefined,
    config: { variables: { napi_build_version: '10' } },
    features: { inspector: false, ipv6: true, tls: false, typescript: false },
    allowedNodeEnvironmentFlags: new Set<string>(),
    stdout: out('stdout'),
    stderr: out('stderr'),
    stdin: Object.assign(new Readable({ read() { this.push(null); } }), { isTTY: false, fd: 0, setRawMode() {} }),
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
    exit(code?: number) {
      const c = code ?? (proc.exitCode as number | undefined) ?? 0;
      proc.emit('exit', c);
      throw new ExitError(c);
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
  return proc;
}
