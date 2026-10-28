/**
 * A small POSIX-style shell for the node runtime: enough to run npm scripts and the commands they
 * start (`vite`, `concurrently "npm:server" "npm:client"`, `cd server && npm run dev`,
 * `PORT=4000 tsx watch src/index.ts`). Every program it runs is a Node program: `node`, a package
 * binary (node_modules/.bin, from the install's .sandburg-bins.json), or an npm/pnpm/yarn script,
 * which it expands (in a workspace package too: `npm -w`, `pnpm --filter`, `yarn workspace`). There
 * are no other programs in the browser; a command it cannot run exits with 127, as `sh` does for a
 * command it cannot find.
 *
 * Supported: `&&`, `||`, `;`, `&` (background), `$VAR`/`${VAR}`, quotes, `NAME=value cmd`, `cd`,
 * `export`, `echo`, `true`, `false`, `exit`, `sleep`, `cross-env`, `env`, `sh -c`/`bash -c`.
 * Pipes and redirections are not: the left-hand command runs and the rest is dropped (with a note).
 */
import { parseWorkspace, WORKSPACE_FILE } from './links.ts';

export interface ShellHost {
  /** Starts a Node program; `onExit` runs once when it ends. */
  node(argv: string[], opts: { cwd: string; env: Record<string, string>; write: (fd: 1 | 2, text: string) => void; onExit: (code: number) => void }): { kill(): void };
  readFile(path: string): string | null;
  exists(path: string): boolean;
  write(fd: 1 | 2, text: string): void;
  onExit(code: number): void;
  /**
   * A step with more steps after it started (+1) or ended (-1): the script has commands still to
   * start (`tsc && node server.js` while tsc runs; `sleep 2 && vite`), see process-tree.ts.
   */
  stepsAhead?(delta: 1 | -1): void;
  /**
   * Runs the script synchronously (execSync): `node` calls onExit before it returns, and the shell
   * waits with `sleep` instead of a timer. Otherwise a builtin's end is a microtask, sleep a timer.
   */
  sync?: { sleep(ms: number): void };
}

type Token = { op: '&&' | '||' | ';' | '&' | '|' | '>' } | { word: string; assign?: boolean };

/** Splits a script into words and operators, expanding variables (not inside single quotes). */
function tokenize(script: string, env: Record<string, string>): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let has = false;
  let quote: string | null = null;
  const flush = () => {
    if (word || has) tokens.push({ word });
    word = '';
    has = false;
  };
  const expand = (i: number): [string, number] => {
    // $VAR, ${VAR}, ${VAR:-default}
    if (script[i + 1] === '{') {
      const end = script.indexOf('}', i + 2);
      if (end < 0) return ['$', i];
      const expr = script.slice(i + 2, end);
      const [name, fallback] = expr.split(':-');
      return [env[name] ?? fallback ?? '', end];
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i + 1));
    if (!m) return ['$', i];
    return [env[m[0]] ?? '', i + m[0].length];
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && /["\\$`]/.test(script[i + 1] ?? '')) word += script[++i];
      else if (c === '$') {
        const [text, end] = expand(i);
        word += text;
        i = end;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < script.length) {
      word += script[++i];
      has = true;
    } else if (c === '$') {
      const [text, end] = expand(i);
      word += text;
      i = end;
    } else if (/\s/.test(c)) flush();
    else if (c === '&' || c === '|' || c === ';' || c === '>' || c === '<') {
      flush();
      const two = script.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        tokens.push({ op: two });
        i++;
      } else if (c === '>' || c === '<') tokens.push({ op: '>' });
      else tokens.push({ op: c });
    } else word += c;
  }
  flush();
  return tokens;
}

interface Step {
  words: string[];
  /** How this step joins the next: &&, ||, ; or & (background). */
  then: '&&' | '||' | ';' | '&';
  /** Dropped redirections or pipes (for a note). */
  dropped: boolean;
}

function steps(tokens: Token[]): Step[] {
  const out: Step[] = [];
  let words: string[] = [];
  let dropped = false;
  let skipping = false;
  for (const t of tokens) {
    if ('op' in t) {
      if (t.op === '|' || t.op === '>') {
        dropped = true;
        skipping = true;
        continue;
      }
      out.push({ words, then: t.op, dropped });
      words = [];
      dropped = false;
      skipping = false;
    } else if (!skipping) words.push(t.word);
  }
  if (words.length) out.push({ words, then: ';', dropped });
  return out;
}

const SCRIPT_RUNNERS = /^(npm|pnpm|yarn|bun)$/;
/** Programs that run a script file under Node, with TypeScript or restarts: the runtime runs the file itself. */
const FILE_RUNNERS = /^(tsx|ts-node|ts-node-dev|ts-node-esm|esno|esr|node-dev|nodemon)$/;
const TS_RUNNERS = /^(tsx|ts-node|ts-node-dev|ts-node-esm|esno|esr)$/;
/** Their options that take a value. */
const RUNNER_VALUE_OPTS = /^(--exec|-e|-r|--require|--import|--loader|--env-file|-w|--watch|--ext|--ignore|-i|--delay|--signal|-x|--tsconfig|-P|--project|--watch-path|--include|--exclude|--ignore-watch|--clear-screen)$/;

/**
 * `tsx watch src/index.ts --port 1` → node src/index.ts --port 1 (with TypeScript for tsx and the
 * like). These tools hook Node's loaders and spawn watchers; the runtime compiles TypeScript itself.
 */
function fileRunner(cmd: string, args: string[]): { argv: string[]; typescript: boolean } | null {
  let k = 0;
  if (args[0] === 'watch' && (cmd === 'tsx' || cmd === 'esno')) k = 1;
  for (; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      k++;
      break;
    }
    if (RUNNER_VALUE_OPTS.test(a)) k++;
    else if (!a.startsWith('-')) break;
  }
  const file = args[k];
  if (!file) return null;
  return { argv: ['node', file, ...args.slice(k + 1)], typescript: TS_RUNNERS.test(cmd) || /\.[cm]?tsx?$/.test(file) };
}

/** Runs a script; resolves nothing, reports through host.onExit. Returns a handle to stop it. */
export function runScript(script: string, cwd: string, env: Record<string, string>, host: ShellHost): { kill(): void } {
  const running = new Set<{ kill(): void }>();
  let killed = false;
  const shellEnv = { ...env };

  const join = (dir: string, rel: string) => {
    if (rel.startsWith('/')) return normalize(rel);
    return normalize(`${dir}/${rel}`);
  };

  /** The script a package manager command runs, or null. */
  const packageScript = (words: string[], dir: string): { script: string; cwd: string; name: string } | { error: string } | null => {
    const [runner, ...rest] = words;
    let args = [...rest];
    let target = dir;
    const take = (flags: string[]) => {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        for (const f of flags) {
          if (a === f && i + 1 < args.length) {
            target = join(dir, args[i + 1]);
            args.splice(i, 2);
            return;
          }
          if (a.startsWith(`${f}=`)) {
            target = join(dir, a.slice(f.length + 1));
            args.splice(i, 1);
            return;
          }
        }
      }
    };
    take(runner === 'npm' ? ['--prefix', '-C'] : runner === 'pnpm' ? ['--dir', '-C', '--prefix'] : ['--cwd', '--prefix']);
    // Every workspace (`npm run dev --workspaces`, `pnpm -r dev`) is not one script: not run here
    // (running the root's own script instead would start it again, and again).
    if (args.some((a) => /^(--workspaces|-ws|-r|--recursive)$/.test(a))) return null;
    // A workspace by name or path: `npm -w web run dev`, `pnpm --filter web dev`, `yarn workspace web dev`.
    const flags = runner === 'npm' ? ['--workspace', '-w'] : runner === 'pnpm' ? ['--filter', '-F'] : [];
    // The package manager's own arguments: those after `--` are the script's.
    const own = args.indexOf('--') < 0 ? args.length : args.indexOf('--');
    // A script in several workspaces (`--filter web --filter api`) is not one script: not run here.
    const selectors: string[] = [];
    for (let i = 0; i < own; i++) {
      if (flags.includes(args[i])) selectors.push(`${args[i]} ${args[++i] ?? ''}`.trim());
      else if (flags.some((f) => args[i].startsWith(`${f}=`))) selectors.push(args[i]);
    }
    if (selectors.length > 1) return { error: `${runner} ${selectors.join(' ')}: several ${flags[0]} selectors are not supported in the browser runtime` };
    for (let i = 0; i < own; i++) {
      const a = args[i];
      const flag = flags.find((f) => a === f || a.startsWith(`${f}=`));
      const value = flag ? (a === flag ? args[i + 1] : a.slice(flag.length + 1)) : runner === 'yarn' && a === 'workspace' && i === 0 ? args[1] : undefined;
      if (value === undefined) continue;
      const as = `${runner} ${flag ?? 'workspace'} ${value}`;
      // pnpm's selectors beyond a name or a directory (`web...`, `./apps/*`, `@scope/*`, `!web`) pick
      // packages by the dependency graph or a pattern: not run here.
      if (runner === 'pnpm' && /\.\.\.|[*!^[\]]/.test(value)) return { error: `${as}: selectors other than a package name or a directory are not supported in the browser runtime` };
      const ws = workspace(value, target);
      if (!ws) return { error: `${as}: no workspace package "${value}"` };
      target = ws;
      args.splice(i, a === flag || a === 'workspace' ? 2 : 1);
      break;
    }
    args = args.filter((a) => !/^(--silent|-s|--if-present|--no-color|--loglevel=.*)$/.test(a));
    let name: string | undefined;
    if (args[0] === 'run' || args[0] === 'run-script') name = args[1];
    else if (args[0] === 'start' || args[0] === 'test' || args[0] === 'dev') name = args[0];
    else if (runner !== 'npm' && args[0] && !/^(install|i|add|exec|dlx|x)$/.test(args[0])) name = args[0];
    if (!name) return null;
    const idx = args.indexOf(name);
    const extra = args.slice(idx + 1).filter((a) => a !== '--');
    const pkg = host.readFile(`${target}/package.json`);
    if (!pkg) return null;
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      return null;
    }
    const body = Object.hasOwn(scripts, name) ? scripts[name] : name === 'start' ? 'node server.js' : undefined;
    if (!body) return null;
    const pre = scripts[`pre${name}`];
    const withArgs = extra.length ? `${body} ${extra.map(quote).join(' ')}` : body;
    return { script: pre ? `${pre} && ${withArgs}` : withArgs, cwd: target, name };
  };

  /**
   * A workspace package's directory, by name (the project's workspace packages: links.ts'
   * WORKSPACE_FILE, from `dir` upwards) or by path; null if there is none.
   */
  const workspace = (value: string, dir: string): string | null => {
    for (let d = dir; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
      const info = parseWorkspace(host.readFile(`${d === '/' ? '' : d}/${WORKSPACE_FILE}`));
      // Its own entries only: `-w constructor` is not Object's.
      const rel = info && Object.hasOwn(info.packages, value) ? info.packages[value] : undefined;
      if (typeof rel === 'string') return join(d, rel);
      if (info) break;
      if (d === '/') break;
    }
    const path = join(dir, value.replace(/^\{(.*)\}$/, '$1'));
    return host.readFile(`${path}/package.json`) !== null ? path : null;
  };

  /** node_modules/.bin/<name>, searched from `dir` upwards. */
  const bin = (name: string, dir: string): string | null => {
    for (let d = dir; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
      const index = host.readFile(`${d === '/' ? '' : d}/node_modules/.sandburg-bins.json`);
      if (index) {
        try {
          const bins = JSON.parse(index) as Record<string, string>;
          const rel = Object.hasOwn(bins, name) ? bins[name] : undefined;
          if (rel) return `${d === '/' ? '' : d}/${rel}`;
        } catch {
          // a broken index: keep looking
        }
      }
      if (d === '/') return null;
    }
  };

  /** Runs one command; calls done(exit code). */
  const command = (input: string[], dir: string, env: Record<string, string>, done: (code: number, cwd?: string) => void) => {
    const words = [...input];
    const localEnv = { ...env };
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const w = words.shift()!;
      localEnv[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1);
    }
    if (!words.length) {
      Object.assign(shellEnv, localEnv);
      return done(0);
    }
    const [cmd, ...args] = words;
    const later = (code: number, newDir?: string) => (host.sync ? done(code, newDir) : queueMicrotask(() => done(code, newDir)));
    switch (cmd) {
      case 'cd': {
        const to = join(dir, args[0] ?? env.HOME ?? '/');
        if (!host.exists(to)) {
          host.write(2, `sh: cd: ${args[0]}: No such file or directory\n`);
          return later(1);
        }
        return later(0, to);
      }
      case 'export':
        for (const a of args) if (a.includes('=')) shellEnv[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
        return later(0);
      case 'echo':
        host.write(1, `${args.join(' ')}\n`);
        return later(0);
      case 'true':
      case ':':
        return later(0);
      case 'false':
        return later(1);
      case 'exit':
        return later(Number(args[0] ?? 0));
      case 'sleep': {
        const seconds = sleepSeconds(args);
        if (typeof seconds === 'string') {
          host.write(2, `sleep: ${seconds}\nTry 'sleep --help' for more information.\n`);
          return later(1);
        }
        if (host.sync) {
          host.sync.sleep(seconds * 1000);
          return done(0);
        }
        // Past setTimeout's range (sleep inf): never.
        if (seconds * 1000 > 2 ** 31 - 1) return;
        return void setTimeout(() => done(0), seconds * 1000);
      }
      case 'cross-env':
      case 'env':
        return command(args, dir, localEnv, done);
      case 'sh':
      case 'bash':
      case '/bin/sh':
      case '/bin/bash':
        if (args[0] === '-c' && args[1] !== undefined) return sequence(args[1], dir, localEnv, (code) => done(code));
        break;
    }
    if (SCRIPT_RUNNERS.test(cmd)) {
      if (cmd === 'npm' && args[0] === 'exec') return command(args.slice(1).filter((a) => a !== '--' && !/^(-y|--yes)$/.test(a)), dir, localEnv, done);
      if ((cmd === 'pnpm' || cmd === 'yarn') && (args[0] === 'exec' || args[0] === 'dlx')) return command(args.slice(1), dir, localEnv, done);
      const target = packageScript(words, dir);
      if (target && 'error' in target) {
        host.write(2, `sh: ${target.error}\n`);
        return later(1);
      }
      if (target) {
        const npmEnv = { ...localEnv, npm_lifecycle_event: target.name, INIT_CWD: localEnv.INIT_CWD ?? dir };
        return sequence(target.script, target.cwd, npmEnv, (code) => done(code));
      }
      host.write(2, `sh: ${words.join(' ')}: package manager commands other than running scripts are not available in the browser runtime\n`);
      return later(127);
    }
    if (cmd === 'npx') {
      const rest = args.filter((a) => !/^(-y|--yes|--no-install|-q|--quiet)$/.test(a));
      return command(rest, dir, localEnv, done);
    }
    let argv: string[] | null = null;
    const runner = FILE_RUNNERS.test(cmd) ? fileRunner(cmd, args) : null;
    if (runner) {
      argv = runner.argv;
      if (runner.typescript) localEnv.SANDBURG_TS_RUNNER = '1';
    } else if (cmd === 'node' || cmd.endsWith('/node')) argv = ['node', ...args];
    else if (/^\.{0,2}\//.test(cmd) && /\.[cm]?[jt]s$/.test(cmd)) argv = ['node', join(dir, cmd), ...args];
    else {
      const script = bin(cmd, dir);
      if (script) argv = ['node', script, ...args];
    }
    if (!argv) {
      host.write(2, `sh: ${cmd}: not found (only Node programs run in the browser runtime)\n`);
      return later(127);
    }
    // Ended already when node() returns, if the shell runs synchronously.
    let ended = false;
    let handle: { kill(): void } | undefined;
    handle = host.node(argv, {
      cwd: dir,
      env: localEnv,
      write: (fd, text) => host.write(fd, text),
      onExit: (code) => {
        ended = true;
        if (handle) running.delete(handle);
        done(code);
      },
    });
    if (!ended) running.add(handle);
  };

  /** Runs a whole script; `done` gets the last foreground command's code. */
  const sequence = (text: string, dir: string, env: Record<string, string>, done: (code: number) => void) => {
    const list = steps(tokenize(text, env));
    let cwd = dir;
    let last = 0;
    let background = 0;
    let finished = false;
    let reachedEnd = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      done(code);
    };
    const next = (i: number, skip: boolean) => {
      if (killed) return finish(143);
      if (i >= list.length) {
        // A script ends when its background commands (a & b) end too, as `wait` would.
        reachedEnd = true;
        if (background === 0) finish(last);
        return;
      }
      const step = list[i];
      if (skip) return next(i + 1, step.then === '&&' ? last !== 0 : step.then === '||' ? last === 0 : false);
      if (step.dropped) host.write(2, `sh: pipes and redirections are not supported; running "${step.words.join(' ')}" alone\n`);
      if (step.then === '&') {
        background++;
        command(step.words, cwd, { ...env, ...shellEnv }, () => {
          background--;
          // Only once the foreground commands are done too (`node seed.js & vite` runs until vite ends).
          if (reachedEnd && background === 0) finish(last);
        });
        return next(i + 1, false);
      }
      const ahead = i < list.length - 1;
      if (ahead) host.stepsAhead?.(1);
      command(step.words, cwd, { ...env, ...shellEnv }, (code, newDir) => {
        if (ahead) host.stepsAhead?.(-1);
        last = code;
        if (newDir) cwd = newDir;
        next(i + 1, step.then === '&&' ? code !== 0 : step.then === '||' ? code === 0 : false);
      });
    };
    next(0, false);
  };

  sequence(script, cwd, env, (code) => host.onExit(code));
  return {
    kill() {
      killed = true;
      for (const r of running) r.kill();
    },
  };
}

/**
 * How long `sleep` waits, in seconds, as GNU sleep reads its arguments (the sum of each, a number with
 * an optional s, m, h or d), or the error it reports.
 */
function sleepSeconds(args: string[]): number | string {
  if (!args.length) return 'missing operand';
  let total = 0;
  for (const a of args) {
    // Units in lower case only; inf in any case; hexadecimal (fractions, binary exponents) as strtod reads it.
    const m = /^\+?(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)([smhd]?)$/.exec(a);
    if (!m) return `invalid time interval '${a}'`;
    total += number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  }
  return total;
}

/** A number as strtod reads sleep's: decimal, inf, or hexadecimal with a fraction and a binary exponent (0x1.8p-1). */
function number(text: string): number {
  if (/^inf/i.test(text)) return Infinity;
  const hex = /^0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)(?:[pP]([+-]?\d+))?$/.exec(text);
  if (!hex) return Number(text);
  return parseInt(`${hex[1]}${hex[2]}` || '0', 16) * 2 ** (Number(hex[3] ?? 0) - 4 * hex[2].length);
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}
