/**
 * child_process for the node runtime. Running `node` (process.execPath, `node`, fork()) starts another
 * runtime in a nested Web Worker, as worker_threads does (threads.ts): it shares the file system, its
 * output goes to the child's stdout/stderr (or this process's, with stdio 'inherit'), fork() and an
 * 'ipc' stdio entry give it process.send(), and servers it starts are reachable like this process's
 * (ThreadHost.relay). CLIs relaunch themselves this way, e.g. with `--conditions=development`.
 * Other commands (`shell: true`, sh -c, npm scripts, package binaries such as `vite` or `tsx`) run
 * in the runtime's shell (shell.ts), whose programs are all Node programs; git or a C compiler
 * cannot run in the browser, and such a command exits with 127.
 */
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { liveRuntimes, startRuntime, type ThreadHost, type ThreadInit } from './threads.ts';
import { timers } from './builtins/process.ts';
import { runScript } from './shell.ts';

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
function nodeOptions(execArgv: string[], env: Record<string, string>) {
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
}

let nextPid = 100;

export function createChildProcess(host: ChildProcessHost) {
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
      const argv = [file, ...args];
      const execPath = host.execPath();
      const stdio = normalizeStdio(options.stdio, forkIpc, options.silent);
      const cwd = options.cwd ? host.resolvePath(options.cwd instanceof URL ? decodeURIComponent(options.cwd.pathname) : String(options.cwd)) : host.cwd();
      const env = Object.fromEntries(Object.entries(options.env ?? host.env()).filter(([, v]) => v !== undefined)) as Record<string, string>;
      if (options.shell || !isNode(argv[0] ?? '', options.execPath ?? execPath)) {
        // A shell command line (spawn(cmd, { shell: true }), exec) is the command as written; otherwise quote the arguments.
        const script = options.shell ? argv.join(' ') : argv.map(shellQuote).join(' ');
        return this.runShell(script, cwd, env, stdio, options);
      }
      const cmd = parseNodeArgs(argv.slice(1));
      if (!cmd.script && cmd.evalCode === null) return this.fail(`${argv[0]} (without a script: the REPL)`);

      const execArgv = [...(forkIpc ? (options.execArgv ?? []) : []), ...cmd.execArgv];
      const { conditions, preload } = nodeOptions(execArgv, env);
      let main: string;
      this.pid = nextPid++;
      if (cmd.evalCode !== null) {
        main = `${cwd}/[eval-${this.pid}].js`;
        host.vfs().write(main, new TextEncoder().encode(cmd.evalCode));
      } else main = cmd.script!.startsWith('/') ? cmd.script! : `${cwd}/${cmd.script}`.replace(/\/\.\//g, '/');
      const ipc = stdio.includes('ipc');
      const init: ThreadInit = {
        id: this.pid,
        workerData: null,
        env,
        argv: cmd.args,
        main,
        process: { cwd, execArgv, conditions, preload: preload.map((p) => (p.startsWith('.') ? `${cwd}/${p}` : p)), ipc },
      };

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
          if (m.type === 'log') write(m.stream === 'stdout' ? 1 : 2, m.text as string);
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
        onExit: (code) => this.finish(code, null),
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
      this.worker.postMessage({ type: 'message', data: message });
      if (cb) timers.setTimeout(() => cb(null), 0);
      return true;
    }
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      this.worker?.postMessage({ type: 'disconnect' });
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

  const argsAndOptions = (a?: unknown, b?: unknown): [string[], SpawnOptions] => (Array.isArray(a) ? [a.map(String), (b ?? {}) as SpawnOptions] : [[], (a ?? {}) as SpawnOptions]);

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
  // Synchronous variants would have to block this thread while it serves the child's file system.
  const syncError = (cmd: string) => notSupported(`running "${cmd}" synchronously`);

  return {
    ChildProcess,
    spawn,
    fork,
    exec,
    execFile,
    spawnSync: (cmd: string) => ({ pid: 0, status: null, signal: null, output: [], stdout: '', stderr: '', error: syncError(cmd) }),
    execSync: (cmd: string) => {
      throw syncError(cmd);
    },
    execFileSync: (cmd: string) => {
      throw syncError(cmd);
    },
  };
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
