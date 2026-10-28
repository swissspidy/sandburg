/**
 * child_process for the node runtime. Running `node` (process.execPath, `node`, fork()) starts another
 * runtime in a nested Web Worker, as worker_threads does (threads.ts): it shares the file system, its
 * output goes to the child's stdout/stderr (or this process's, with stdio 'inherit'), fork() and an
 * 'ipc' stdio entry give it process.send(), and servers it starts are reachable like this process's
 * (ThreadHost.relay). CLIs relaunch themselves this way, e.g. with `--conditions=development`.
 * Other commands (`shell: true`, sh -c, npm scripts, package binaries such as `vite` or `tsx`) run
 * in the runtime's shell (shell.ts), whose programs are all Node programs; git or a C compiler
 * cannot run in the browser, and such a command exits with 127.
 *
 * execSync, spawnSync and execFileSync run the same commands while this thread blocks: the shell
 * runs here, synchronously, and each Node program it starts (or the one given) runs in a child
 * runtime that this thread serves through shared memory until it exits (sync-child.ts).
 */
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { liveRuntimes, startRuntime, type ThreadHost } from './threads.ts';
import { timers } from './builtins/process.ts';
import { runScript } from './shell.ts';
import { devScriptRunning, shellStepsAhead } from './process-tree.ts';
import { serveSyncChild, syncChannel, type SyncEnd } from './sync-child.ts';
import type { ThreadInit, ToWorker } from './messages.ts';

const notSupported = (what: string) => Object.assign(new Error(`${what} is not available in the browser runtime`), { code: 'ENOSYS', errno: -38 });

type Stdio = 'pipe' | 'inherit' | 'ignore' | 'ipc' | 'overlapped' | null | undefined | number | object;
interface SpawnOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  stdio?: Stdio | Stdio[];
  shell?: boolean | string;
  execArgv?: string[];
  execPath?: string;
  silent?: boolean;
  signal?: AbortSignal;
  encoding?: string;
  /** A command of a shell script: report it when it fails (see ChildProcessHost.reportExit). */
  sandburgCommand?: boolean;
  /** The dev script, run by the program Sandburg starts for it, which only waits on it (see process-tree.ts). */
  sandburgDevScript?: boolean;
}

/** A command line split into words (quotes and backslash escapes, as a POSIX shell would). */
function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (word || has) words.push(word);
      word = '';
      has = false;
    } else word += c;
  }
  if (word || has) words.push(word);
  return words;
}

const isNode = (cmd: string, execPath: string) => cmd === execPath || /(^|\/)node(\.exe)?$/.test(cmd);
/** node's own flags that take a separate value (`--require x`). */
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '-C', '--conditions', '--loader', '--experimental-loader', '--env-file', '--input-type', '--inspect-port', '--title', '--stack-size', '--max-old-space-size']);

interface NodeCommand {
  execArgv: string[];
  script: string | null;
  evalCode: string | null;
  args: string[];
}

/** Splits `node [options] [script | -e code] [args]`. */
function parseNodeArgs(argv: string[]): NodeCommand {
  const execArgv: string[] = [];
  let i = 0;
  let evalCode: string | null = null;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print') {
      evalCode = a === '-p' || a === '--print' ? `console.log(${argv[i + 1]})` : argv[i + 1];
      execArgv.push(a, argv[++i]);
      i++;
      break;
    }
    execArgv.push(a);
    if (VALUE_FLAGS.has(a) && i + 1 < argv.length) execArgv.push(argv[++i]);
  }
  if (evalCode !== null) return { execArgv, script: null, evalCode, args: argv.slice(i) };
  return { execArgv, script: argv[i] ?? null, evalCode: null, args: argv.slice(i + 1) };
}

/** --conditions and --require/--import from node's options (and NODE_OPTIONS). */
export function nodeOptions(execArgv: string[], env: Record<string, string>) {
  const all = [...splitCommand(env.NODE_OPTIONS ?? ''), ...execArgv];
  const conditions: string[] = [];
  const preload: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : a.startsWith('-C') && a.length > 2 ? ['-C', a.slice(2)] : [a, undefined];
    const value = () => inline ?? all[++i];
    if (flag === '-C' || flag === '--conditions') conditions.push(value());
    else if (flag === '-r' || flag === '--require' || flag === '--import') preload.push(value());
    else if (VALUE_FLAGS.has(flag) && inline === undefined) i++;
  }
  return { conditions, preload };
}

export interface ChildProcessHost extends ThreadHost {
  execPath(): string;
  /** A command a shell script ran (a dev script's server, say) exited with an error. */
  reportExit?(info: { command: string; code: number; stderr: string }): void;
  /**
   * Starts the runtime of a synchronous child process, whose channel `sync` this thread then serves
   * (sync-child.ts); null if it cannot be started now. kill() ends it.
   */
  spawnSync?(init: ThreadInit, sync: SharedArrayBuffer): { kill(): void } | null;
}

interface SyncOptions extends SpawnOptions {
  input?: string | ArrayBufferView;
  timeout?: number;
  maxBuffer?: number;
  killSignal?: string | number;
  argv0?: string;
}

/** spawnSync's result, in Node's order of keys. */
interface SyncResult {
  error?: Error;
  status: number | null;
  signal: string | null;
  output: (string | Buffer | null)[] | null;
  pid: number;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

/** What `spawn(file, args, options)` runs: a shell script, a Node program, or nothing (the REPL). */
type Plan = { argv: string[]; cwd: string; env: Record<string, string>; stdio: Stdio[] } & ({ kind: 'shell'; script: string } | { kind: 'node'; init: ThreadInit } | { kind: 'fail'; command: string });

let nextPid = 100;

export function createChildProcess(host: ChildProcessHost) {
  /** `stdin`: what a synchronous child reads from its stdin, which `node` without a script runs, as Node does. */
  function plan(file: string, args: string[], options: SpawnOptions, forkIpc: boolean, stdin?: string): Plan {
    const argv = [file, ...args];
    const execPath = host.execPath();
    const stdio = normalizeStdio(options.stdio, forkIpc, options.silent);
    const cwd = options.cwd ? host.resolvePath(options.cwd instanceof URL ? decodeURIComponent(options.cwd.pathname) : String(options.cwd)) : host.cwd();
    const env = Object.fromEntries(Object.entries(options.env ?? host.env()).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const common = { argv, cwd, env, stdio };
    if (options.shell || !isNode(argv[0] ?? '', options.execPath ?? execPath)) {
      // A shell command line (spawn(cmd, { shell: true }), exec) is the command as written; otherwise quote the arguments.
      return { ...common, kind: 'shell', script: options.shell ? argv.join(' ') : argv.map(shellQuote).join(' ') };
    }
    const cmd = parseNodeArgs(argv.slice(1));
    if (!cmd.script && cmd.evalCode === null && stdin !== undefined) cmd.evalCode = stdin;
    if (!cmd.script && cmd.evalCode === null) return { ...common, kind: 'fail', command: `${argv[0]} (without a script: the REPL)` };

    const execArgv = [...(forkIpc ? (options.execArgv ?? []) : []), ...cmd.execArgv];
    const { conditions, preload } = nodeOptions(execArgv, env);
    let main: string;
    const pid = nextPid++;
    if (cmd.evalCode !== null) {
      main = `${cwd}/[eval-${pid}].js`;
      host.vfs().write(main, new TextEncoder().encode(cmd.evalCode));
    } else main = cmd.script!.startsWith('/') ? cmd.script! : `${cwd}/${cmd.script}`.replace(/\/\.\//g, '/');
    const init: ThreadInit = {
      id: pid,
      workerData: null,
      env,
      argv: cmd.args,
      main,
      process: { cwd, execArgv, conditions, preload: preload.map((p) => (p.startsWith('.') ? `${cwd}/${p}` : p)), ipc: stdio.includes('ipc') },
    };
    return { ...common, kind: 'node', init };
  }

  class ChildProcess extends EventEmitter {
    pid: number | undefined = undefined;
    stdin: Writable | null = null;
    stdout: Readable | null = null;
    stderr: Readable | null = null;
    stdio: (Readable | Writable | null)[] = [];
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    connected = false;
    spawnfile = '';
    spawnargs: string[] = [];
    private worker: globalThis.Worker | null = null;
    private shell: { kill(): void } | null = null;
    private done = false;

    /** Starts `node …` as a nested runtime, or fails (asynchronously, as Node does) for any other program. */
    start(file: string, args: string[], options: SpawnOptions, forkIpc: boolean) {
      this.spawnfile = file;
      this.spawnargs = [file, ...args];
      const p = plan(file, args, options, forkIpc);
      if (p.kind === 'shell') return this.runShell(p.script, p.cwd, p.env, p.stdio, options);
      if (p.kind === 'fail') return this.fail(p.command);
      const { argv, stdio, init } = p;
      this.pid = init.id;
      const ipc = init.process!.ipc;

      // stdio: 'pipe' gives streams, 'inherit' writes to this process's output, 'ignore' drops it.
      const out = (fd: 1 | 2) => (stdio[fd] === 'pipe' ? new Readable({ read() {} }) : null);
      this.stdout = out(1);
      this.stderr = out(2);
      this.stdin = stdio[0] === 'pipe' ? new Writable({ write: (_c, _e, cb) => cb() }) : null;
      this.stdio = [this.stdin, this.stdout, this.stderr];
      for (const s of [this.stdout, this.stderr]) if (s && options.encoding && options.encoding !== 'buffer') s.setEncoding(options.encoding as BufferEncoding);
      let stderrTail = '';
      const write = (fd: 1 | 2, text: string) => {
        if (fd === 2 && options.sandburgCommand) stderrTail = (stderrTail + text).slice(-4000);
        if (stdio[fd] === 'inherit') host.write(fd === 1 ? 'stdout' : 'stderr', text);
        else if (stdio[fd] === 'pipe') (fd === 1 ? this.stdout : this.stderr)!.push(Buffer.from(text));
      };
      if (options.sandburgCommand) {
        this.once('exit', (code: number | null) => {
          if (code && !this.killed) host.reportExit?.({ command: argv.join(' '), code, stderr: stderrTail });
        });
      }
      this.connected = ipc;
      options.signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true });

      this.worker = startRuntime(
        host,
        init,
        (m) => {
          if (m.type === 'log') write(m.stream === 'stdout' ? 1 : 2, m.text);
          else if (m.type === 'message') this.emit('message', m.data);
          else if (m.type === 'exit') this.finish(Number(m.code ?? 0), null);
          else if (m.type === 'fatal') {
            write(2, `${m.stack ?? m.message}\n`);
            this.finish(1, null);
          }
        },
        (message) => {
          write(2, `${message}\n`);
          this.finish(1, null);
        },
      );
      timers.setTimeout(() => this.emit('spawn'), 0);
    }

    /** Runs a command line in the runtime's shell; each Node program it starts is a child runtime. */
    private runShell(script: string, cwd: string, env: Record<string, string>, stdio: Stdio[], options: SpawnOptions) {
      this.pid = nextPid++;
      const out = (fd: 1 | 2) => (stdio[fd] === 'pipe' ? new Readable({ read() {} }) : null);
      this.stdout = out(1);
      this.stderr = out(2);
      this.stdin = stdio[0] === 'pipe' ? new Writable({ write: (_c, _e, cb) => cb() }) : null;
      this.stdio = [this.stdin, this.stdout, this.stderr];
      for (const s of [this.stdout, this.stderr]) if (s && options.encoding && options.encoding !== 'buffer') s.setEncoding(options.encoding as BufferEncoding);
      const write = (fd: 1 | 2, text: string) => {
        if (stdio[fd] === 'inherit') host.write(fd === 1 ? 'stdout' : 'stderr', text);
        else if (stdio[fd] === 'pipe') (fd === 1 ? this.stdout : this.stderr)!.push(Buffer.from(text));
      };
      const vfs = host.vfs();
      options.signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true });
      if (options.sandburgDevScript) {
        devScriptRunning(1);
        this.once('exit', () => devScriptRunning(-1));
      }
      this.shell = runScript(script, cwd, env, {
        node: (argv, o) => {
          const child = new ChildProcess();
          child.start(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], sandburgCommand: true }, false);
          child.stdout?.on('data', (d: Buffer) => o.write(1, d.toString()));
          child.stderr?.on('data', (d: Buffer) => o.write(2, d.toString()));
          let ended = false;
          const end = (code: number | null) => {
            if (ended) return;
            ended = true;
            o.onExit(code ?? 1);
          };
          child.on('exit', (code: number | null) => end(code));
          child.on('error', () => end(127));
          return { kill: () => child.kill() };
        },
        readFile: (path) => {
          try {
            return new TextDecoder().decode(vfs.read(path));
          } catch {
            return null;
          }
        },
        exists: (path) => vfs.exists(path),
        write,
        // Once killed, the script's end (its commands killed: 143) is not its exit: kill() reports the signal.
        onExit: (code) => {
          if (!this.killed) this.finish(code, null);
        },
        stepsAhead: shellStepsAhead,
      });
      timers.setTimeout(() => this.emit('spawn'), 0);
    }

    private fail(command: string) {
      timers.setTimeout(() => {
        this.emit('error', Object.assign(notSupported(`spawning "${command}"`), { path: command, spawnargs: this.spawnargs.slice(1) }));
        this.exitCode = -38;
        this.emit('close', -38, null);
      }, 0);
    }

    private finish(code: number | null, signal: string | null) {
      if (this.done) return;
      this.done = true;
      this.worker?.terminate();
      this.exitCode = code;
      this.signalCode = signal;
      if (this.connected) {
        this.connected = false;
        this.emit('disconnect');
      }
      this.stdout?.push(null);
      this.stderr?.push(null);
      this.emit('exit', code, signal);
      timers.setTimeout(() => this.emit('close', code, signal), 0);
    }

    kill(signal: string | number = 'SIGTERM') {
      if (this.done || (!this.worker && !this.shell)) return false;
      this.killed = true;
      this.shell?.kill();
      this.finish(null, typeof signal === 'number' ? 'SIGTERM' : signal);
      return true;
    }
    send(message: unknown, ...rest: unknown[]) {
      const cb = rest.find((x) => typeof x === 'function') as ((e: Error | null) => void) | undefined;
      if (!this.connected || !this.worker) {
        const err = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
        if (cb) timers.setTimeout(() => cb(err), 0);
        else timers.setTimeout(() => this.emit('error', err), 0);
        return false;
      }
      this.worker.postMessage({ type: 'message', data: message } satisfies ToWorker);
      if (cb) timers.setTimeout(() => cb(null), 0);
      return true;
    }
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      this.worker?.postMessage({ type: 'disconnect' } satisfies ToWorker);
      timers.setTimeout(() => this.emit('disconnect'), 0);
    }
    ref() {
      if (this.worker && !this.done) liveRuntimes.add(this.worker);
      return this;
    }
    unref() {
      if (this.worker) liveRuntimes.delete(this.worker);
      return this;
    }
    [Symbol.dispose]() {
      this.kill();
    }
  }

  const argsAndOptions = (a?: unknown, b?: unknown): [string[], SpawnOptions] => (Array.isArray(a) ? [a.map(String), (b ?? {})] : [[], (a ?? {})]);

  function spawn(file: string, a?: unknown, b?: unknown) {
    const [args, options] = argsAndOptions(a, b);
    const child = new ChildProcess();
    child.start(String(file), args, options, false);
    return child;
  }
  function fork(modulePath: string | URL, a?: unknown, b?: unknown) {
    const [args, options] = argsAndOptions(a, b);
    const path = modulePath instanceof URL ? decodeURIComponent(modulePath.pathname) : String(modulePath);
    const child = new ChildProcess();
    child.start(options.execPath ?? host.execPath(), [...(options.execArgv ?? []), path, ...args], { ...options, execArgv: [] }, true);
    return child;
  }
  /** Runs a command to completion, collecting its output (exec, execFile). */
  function collect(child: ChildProcess, options: SpawnOptions, cb?: (e: Error | null, out: string | Buffer, err: string | Buffer) => void) {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer | string) => out.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer | string) => err.push(Buffer.from(d)));
    const text = (b: Buffer[]) => (options.encoding === 'buffer' ? Buffer.concat(b) : Buffer.concat(b).toString((options.encoding as BufferEncoding) ?? 'utf8'));
    let failed = false;
    child.on('error', (e) => {
      failed = true;
      cb?.(e, text(out), text(err));
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (failed) return;
      const e = code === 0 ? null : Object.assign(new Error(`Command failed: ${child.spawnargs.join(' ')}\n${text(err)}`), { code, signal, killed: child.killed, cmd: child.spawnargs.join(' ') });
      cb?.(e, text(out), text(err));
    });
    return child;
  }
  function exec(command: string, a?: unknown, b?: unknown) {
    const options = (typeof a === 'object' && a) || {};
    const cb = [a, b].find((x) => typeof x === 'function') as Parameters<typeof collect>[2];
    const child = new ChildProcess();
    child.start(command, [], { ...options, shell: true, stdio: 'pipe' }, false);
    return collect(child, options, cb);
  }
  function execFile(file: string, a?: unknown, b?: unknown, c?: unknown) {
    const args = Array.isArray(a) ? a.map(String) : [];
    const options = ([a, b].find((x) => x && typeof x === 'object' && !Array.isArray(x)) ?? {}) as SpawnOptions;
    const cb = [a, b, c].find((x) => typeof x === 'function') as Parameters<typeof collect>[2];
    const child = new ChildProcess();
    child.start(file, args, { ...options, stdio: 'pipe' }, false);
    return collect(child, options, cb);
  }
  const ERRNO: Record<string, number> = { ETIMEDOUT: -110, ENOBUFS: -105 };
  const spawnError = (code: string, file: string, spawnargs: string[]) =>
    Object.assign(new Error(`spawnSync ${file} ${code}`), { errno: ERRNO[code], code, syscall: `spawnSync ${file}`, path: file, spawnargs });

  /**
   * spawnSync: runs the command while this thread blocks (see sync-child.ts), with Node's result.
   * `api` names the call in the error for a command that cannot start (no helper to start it).
   */
  function runSync(api: string, file: string, args: string[], options: SyncOptions): SyncResult {
    const input = options.input === undefined ? undefined : typeof options.input === 'string' ? Buffer.from(options.input, (options.encoding && options.encoding !== 'buffer' ? options.encoding : 'utf8') as BufferEncoding) : new Uint8Array(options.input.buffer, options.input.byteOffset, options.input.byteLength).slice();
    const stdinText = input ? new TextDecoder().decode(input) : '';
    const p = plan(file, args, options, false, stdinText);
    const { stdio } = p;
    // As Node reports it: a shell command is /bin/sh -c <script>.
    const [errFile, errArgs] = p.kind === 'shell' && options.shell ? [typeof options.shell === 'string' ? options.shell : '/bin/sh', ['-c', p.script]] : [file, args];
    const deadline = options.timeout && options.timeout > 0 ? performance.now() + options.timeout : Infinity;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const chunks: Buffer[][] = [[], [], []];
    const sizes = [0, 0, 0];
    /** Why the command ended early: its time or its output ran out, its runtime failed or could not start. */
    let stopped: { timedOut: true } | { overflow: true } | { error: Error } | null = null;
    const write = (fd: 1 | 2, text: string): boolean => {
      if (stopped) return false;
      if (stdio[fd] === 'inherit') host.write(fd === 1 ? 'stdout' : 'stderr', text);
      else if (stdio[fd] === 'pipe') {
        const bytes = Buffer.from(text);
        chunks[fd].push(bytes);
        sizes[fd] += bytes.length;
        if (sizes[fd] > maxBuffer) return false;
      }
      return true;
    };
    /** Runs a Node program to its end: its exit code, or null once stopped. */
    const runNode = (init: ThreadInit): number | null => {
      if (stopped) return null;
      if (performance.now() >= deadline) {
        stopped = { timedOut: true };
        return null;
      }
      const sync = syncChannel();
      const child = host.spawnSync?.({ ...init, process: { ...init.process!, sync, stdin: input } }, sync) ?? null;
      if (!child) {
        const command = [file, ...args].join(' ');
        stopped = {
          error: Object.assign(new Error(`child_process.${api}("${command}") cannot run yet: the runtime's helper worker, which starts a synchronous child process, has not started. Call it once the program has run a task (after an await or a timer), or use the asynchronous API.`), {
            code: 'ENOSYS',
            errno: -38,
            syscall: `spawnSync ${errFile}`,
            path: errFile,
            spawnargs: errArgs,
          }),
        };
        return null;
      }
      let end: SyncEnd;
      try {
        end = serveSyncChild(sync, host.vfs(), deadline, write);
      } finally {
        child.kill();
      }
      if ('code' in end) return end.code;
      if ('crashed' in end) {
        write(2, 'the child process\'s runtime failed to start or crashed\n');
        return 1;
      }
      stopped = end;
      return null;
    };

    let status: number | null = null;
    let pid = nextPid;
    if (p.kind === 'fail') stopped = { error: Object.assign(notSupported(`spawning "${p.command}"`), { path: p.command, spawnargs: args }) };
    else if (p.kind === 'node') {
      pid = p.init.id;
      status = runNode(p.init);
    } else {
      pid = nextPid++;
      runScript(p.script, p.cwd, p.env, {
        node: (argv, o) => {
          const sub = plan(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env }, false, stdinText);
          o.onExit(sub.kind === 'node' ? (runNode(sub.init) ?? 143) : 127);
          return { kill: () => {} };
        },
        readFile: (path) => {
          try {
            return new TextDecoder().decode(host.vfs().read(path));
          } catch {
            return null;
          }
        },
        exists: (path) => host.vfs().exists(path),
        write: (fd, text) => {
          if (!write(fd, text) && !stopped) stopped = { overflow: true };
        },
        onExit: (code) => {
          status = code;
        },
        sync: {
          sleep: (ms) => {
            if (stopped) return;
            const left = deadline - performance.now();
            const wait = Math.min(Number.isNaN(ms) ? 0 : ms, left);
            if (wait === Infinity) {
              // sleep inf without a timeout: as it would natively, until killed (nothing kills this thread's wait).
              stopped = { error: Object.assign(new Error(`child_process.${api}: "sleep" without end and without a timeout would block this thread forever`), { code: 'EINVAL' }) };
              return;
            }
            if (ms >= left) stopped = { timedOut: true };
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, wait));
          },
        },
      });
    }
    const encoding = options.encoding && options.encoding !== 'buffer' ? (options.encoding as BufferEncoding) : null;
    const output = (fd: 1 | 2) => {
      if (stdio[fd] !== 'pipe') return null;
      const bytes = Buffer.concat(chunks[fd]);
      return encoding ? bytes.toString(encoding) : bytes;
    };
    const stdout = output(1);
    const stderr = output(2);
    // What it wrote before it could not go on (a script whose later command could not start).
    if (stopped && 'error' in stopped) return { error: stopped.error, status: null, signal: null, output: [null, stdout, stderr], pid: 0, stdout, stderr };
    const signal = stopped ? signalName(options.killSignal) : null;
    const result: SyncResult = { status: stopped ? null : status, signal, output: [null, stdout, stderr], pid, stdout, stderr };
    return stopped ? { error: spawnError('timedOut' in stopped ? 'ETIMEDOUT' : 'ENOBUFS', errFile, errArgs), ...result } : result;
  }

  /** execSync's and execFileSync's end: stderr shown unless stdio was given, an error for a failure (Node's checkExecSyncError). */
  function execResult(ret: SyncResult, options: SyncOptions, command: string): string | Buffer | null | undefined {
    if (!options.stdio && ret.stderr) host.write('stderr', ret.stderr.toString());
    if (ret.error) throw Object.assign(ret.error, ret);
    if (ret.status !== 0) {
      const stderr = ret.stderr?.length ? `\n${ret.stderr.toString()}` : '';
      throw Object.assign(new Error(`Command failed: ${command}${stderr}`), ret);
    }
    return ret.stdout;
  }

  function spawnSync(file: string, a?: unknown, b?: unknown): SyncResult {
    const [args, options] = argsAndOptions(a, b) as [string[], SyncOptions];
    return runSync('spawnSync', String(file), args, options);
  }
  function execSync(command: string, options: SyncOptions = {}) {
    return execResult(runSync('execSync', String(command), [], { ...options, shell: options.shell || true }), options, command);
  }
  function execFileSync(file: string, a?: unknown, b?: unknown) {
    const [args, options] = argsAndOptions(a, b) as [string[], SyncOptions];
    return execResult(runSync('execFileSync', String(file), args, options), options, [options.argv0 ?? file, ...args].join(' '));
  }

  return {
    ChildProcess,
    spawn,
    fork,
    exec,
    execFile,
    spawnSync,
    execSync,
    execFileSync,
  };
}

/** Linux's signals by number (os.constants.signals), for a numeric killSignal. */
const SIGNALS = ['', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGPWR', 'SIGSYS'];

/** A kill signal's name (SIGTERM by default). */
function signalName(signal: string | number | undefined): string {
  if (typeof signal === 'number') return SIGNALS[signal] || 'SIGTERM';
  return signal ?? 'SIGTERM';
}

function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function normalizeStdio(stdio: Stdio | Stdio[] | undefined, forkIpc: boolean, silent?: boolean): Stdio[] {
  let list: Stdio[];
  if (Array.isArray(stdio)) list = [...stdio];
  else if (stdio === undefined) list = forkIpc ? (silent ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit']) : ['pipe', 'pipe', 'pipe'];
  else list = [stdio, stdio, stdio];
  for (let i = 0; i < 3; i++) {
    const v = list[i];
    // A file descriptor or stream of this process (process.stdout): the child writes to this process's output.
    list[i] = v === null || v === undefined || v === 'overlapped' ? 'pipe' : typeof v === 'number' ? (v <= 2 ? 'inherit' : 'ignore') : typeof v === 'object' ? 'inherit' : v;
  }
  if (forkIpc && !list.includes('ipc')) list.push('ipc');
  return list;
}
