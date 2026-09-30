/**
 * A small POSIX-style shell for the node runtime: enough to run npm scripts and the commands they
 * start (`vite`, `concurrently "npm:server" "npm:client"`, `cd server && npm run dev`,
 * `PORT=4000 tsx watch src/index.ts`). Every program it runs is a Node program: `node`, a package
 * binary (node_modules/.bin, from the install's .sandburg-bins.json), or an npm/pnpm/yarn script,
 * which it expands. There are no other programs in the browser; a command it cannot run exits with
 * 127, as `sh` does for a command it cannot find.
 *
 * Supported: `&&`, `||`, `;`, `&` (background), `$VAR`/`${VAR}`, quotes, `NAME=value cmd`, `cd`,
 * `export`, `echo`, `true`, `false`, `exit`, `sleep`, `cross-env`, `env`, `sh -c`/`bash -c`.
 * Pipes and redirections are not: the left-hand command runs and the rest is dropped (with a note).
 */

export interface ShellHost {
  /** Starts a Node program; `onExit` runs once when it ends. */
  node(argv: string[], opts: { cwd: string; env: Record<string, string>; write: (fd: 1 | 2, text: string) => void; onExit: (code: number) => void }): { kill(): void };
  readFile(path: string): string | null;
  exists(path: string): boolean;
  write(fd: 1 | 2, text: string): void;
  onExit(code: number): void;
}

type Token = { op: '&&' | '||' | ';' | '&' | '|' | '>' } | { word: string; assign?: boolean };

/** Splits a script into words and operators, expanding variables (not inside single quotes). */
export function tokenize(script: string, env: Record<string, string>): Token[] {
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
      else tokens.push({ op: c as '&' | '|' | ';' });
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
  const packageScript = (words: string[], dir: string): { script: string; cwd: string; name: string } | null => {
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
    const body = scripts[name] ?? (name === 'start' ? 'node server.js' : undefined);
    if (!body) return null;
    const pre = scripts[`pre${name}`];
    const withArgs = extra.length ? `${body} ${extra.map(quote).join(' ')}` : body;
    return { script: pre ? `${pre} && ${withArgs}` : withArgs, cwd: target, name };
  };

  /** node_modules/.bin/<name>, searched from `dir` upwards. */
  const bin = (name: string, dir: string): string | null => {
    for (let d = dir; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
      const index = host.readFile(`${d === '/' ? '' : d}/node_modules/.sandburg-bins.json`);
      if (index) {
        try {
          const rel = (JSON.parse(index) as Record<string, string>)[name];
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
    const later = (code: number, newDir?: string) => queueMicrotask(() => done(code, newDir));
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
      case 'sleep':
        return void setTimeout(() => done(0), Number(args[0] ?? 0) * 1000);
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
    const handle = host.node(argv, {
      cwd: dir,
      env: localEnv,
      write: (fd, text) => host.write(fd, text),
      onExit: (code) => {
        running.delete(handle);
        done(code);
      },
    });
    running.add(handle);
  };

  /** Runs a whole script; `done` gets the last foreground command's code. */
  const sequence = (text: string, dir: string, env: Record<string, string>, done: (code: number) => void) => {
    const list = steps(tokenize(text, env));
    let cwd = dir;
    let last = 0;
    let background = 0;
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      done(code);
    };
    const next = (i: number, skip: boolean) => {
      if (killed) return finish(143);
      if (i >= list.length) {
        // A script ends when its background commands (a & b) end too, as `wait` would.
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
          if (i === list.length - 1 || background === 0) next(list.length, false);
        });
        return next(i + 1, false);
      }
      command(step.words, cwd, { ...env, ...shellEnv }, (code, newDir) => {
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
