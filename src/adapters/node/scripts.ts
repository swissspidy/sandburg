/**
 * How a project's dev scripts start it (ADR 0009, 0014): the commands they run,
 * the packages they run them in, and the routes between a front end and its
 * backend.
 *
 * Typical shapes of generated apps:
 * - one package.json: "dev": "concurrently \"vite\" \"node server/index.js\""
 *   (or npm:server/npm:client, npm-run-all, run-p, `&`);
 * - client/ and server/ packages started from the root, or from each other;
 * - Vite's server.proxy sending /api to http://localhost:3001, or the front
 *   end calling http://localhost:3001 directly (CORS).
 *
 * Pure: it reads only the project files.
 */
type Files = Record<string, string | Uint8Array | { base64: string }>;

export interface BackendCommand {
  /** Package directory the command runs in ("" is the project root). */
  dir: string;
  /** The server entry, relative to `dir`. */
  main: string;
  /** The command as written, for logs. */
  command: string;
}

export interface ProxyRule {
  /** Path prefix (Vite matches keys starting with ^ as regular expressions). */
  prefix: string;
  regex?: string;
  port: number;
  /** Prefix removed by a `rewrite: (p) => p.replace(/^\/api/, '')` option. */
  strip?: string;
}

export interface FullStackLayout {
  /** Directory of the front end (index.html, vite.config): "" or e.g. "client". */
  frontend: string;
  backend: BackendCommand | null;
  proxy: ProxyRule[];
}

const CONCURRENTLY_VALUE_OPTS = /^(-n|--names|-c|--prefix-colors|-p|--prefix|-l|--prefix-length|-t|--timestamp-format|-m|--max-processes|-s|--success|--restart-tries|--restart-after|--default-input-target|--kill-signal|--passthrough-arguments-separator)$/;
const SERVER_RUNNERS = /^(node|nodemon|tsx|ts-node|ts-node-dev|ts-node-esm|node-dev|esno|esr)$/;
const FRONTEND_DIRS = ['', 'client', 'frontend', 'web', 'app', 'ui'];
const BACKEND_DIRS = ['server', 'backend', 'api'];

const text = (files: Files, path: string) => {
  const v = files[path];
  return typeof v === 'string' ? v : null;
};

function readPackage(files: Files, dir: string): { scripts: Record<string, string>; main?: string } | null {
  const raw = text(files, dir ? `${dir}/package.json` : 'package.json');
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; main?: string };
    return { scripts: pkg.scripts ?? {}, main: pkg.main };
  } catch {
    return null;
  }
}

/** Splits a shell-ish command line into words, keeping quoted strings together. */
export function splitWords(command: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of command.matchAll(re)) words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return words;
}

interface Leaf {
  dir: string;
  words: string[];
  command: string;
}

/** Expands a script into the leaf commands it starts, following npm run, concurrently, npm-run-all and cd. */
export function expandScript(files: Files, dir: string, command: string, depth = 0): Leaf[] {
  if (depth > 8) return [];
  const leaves: Leaf[] = [];
  let cwd = dir;
  // `a && b`, `a & b`, `a; b`: every part runs (sequentially or in the background).
  for (const part of command.split(/\s*(?:&&|\|\||;|(?<!&)&(?!&))\s*/)) {
    const words = splitWords(part.trim());
    // Environment assignments (PORT=3001 node …) and cross-env.
    while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words.shift();
    if (words[0] === 'cross-env') {
      words.shift();
      while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words.shift();
    }
    if (!words.length) continue;
    const [cmd, ...args] = words;
    if (cmd === 'cd' && args[0]) {
      cwd = joinDir(cwd, args[0]);
      continue;
    }
    if (cmd === 'npx' || cmd === 'pnpm' && args[0] === 'exec' || cmd === 'yarn' && args[0] === 'exec') {
      const rest = cmd === 'npx' ? args.filter((a) => !/^(-y|--yes)$/.test(a)) : args.slice(1);
      leaves.push(...expandScript(files, cwd, rest.map(quote).join(' '), depth + 1));
      continue;
    }
    const run = npmRun(cmd, args);
    if (run) {
      const target = run.prefix ? joinDir(cwd, run.prefix) : cwd;
      const script = readPackage(files, target)?.scripts[run.script];
      if (script) leaves.push(...expandScript(files, target, script, depth + 1));
      continue;
    }
    if (cmd === 'concurrently') {
      // Flags are skipped; those that take a value (-n api,web) skip it too, unless written as --opt=value.
      const commands: string[] = [];
      for (let k = 0; k < args.length; k++) {
        if (CONCURRENTLY_VALUE_OPTS.test(args[k])) k++;
        else if (!args[k].startsWith('-')) commands.push(args[k]);
      }
      for (const arg of commands) {
        if (arg.startsWith('npm:') || arg.startsWith('yarn:') || arg.startsWith('pnpm:')) {
          const name = arg.slice(arg.indexOf(':') + 1);
          const scripts = readPackage(files, cwd)?.scripts ?? {};
          for (const key of Object.keys(scripts).filter((k) => (name.endsWith('*') ? k.startsWith(name.slice(0, -1)) : k === name))) {
            leaves.push(...expandScript(files, cwd, scripts[key], depth + 1));
          }
        } else leaves.push(...expandScript(files, cwd, arg, depth + 1));
      }
      continue;
    }
    if (cmd === 'npm-run-all' || cmd === 'run-p' || cmd === 'run-s' || cmd === 'npm-run-all2') {
      const scripts = readPackage(files, cwd)?.scripts ?? {};
      for (const name of args.filter((a) => !a.startsWith('-'))) {
        const pattern = new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*?/g, '.*')}$`);
        for (const key of Object.keys(scripts).filter((k) => pattern.test(k))) leaves.push(...expandScript(files, cwd, scripts[key], depth + 1));
      }
      continue;
    }
    leaves.push({ dir: cwd, words: [cmd, ...args], command: part.trim() });
  }
  return leaves;
}

function quote(word: string): string {
  return /\s/.test(word) ? JSON.stringify(word) : word;
}

/** `npm run x`, `npm start`, `npm --prefix server run dev`, `yarn x`, `pnpm x`, `pnpm --dir server x`. */
function npmRun(cmd: string, args: string[]): { script: string; prefix?: string } | null {
  if (cmd !== 'npm' && cmd !== 'yarn' && cmd !== 'pnpm' && cmd !== 'bun') return null;
  let prefix: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prefix' || a === '-C' || a === '--dir' || a === '--cwd') prefix = args[++i];
    else if (a.startsWith('--prefix=') || a.startsWith('--dir=') || a.startsWith('--cwd=')) prefix = a.slice(a.indexOf('=') + 1);
    else if (a === '--') break;
    else if (!a.startsWith('-')) rest.push(a);
  }
  if (!rest.length) return null;
  if (rest[0] === 'run' || rest[0] === 'run-script') return rest[1] ? { script: rest[1], prefix } : null;
  if (rest[0] === 'start' || rest[0] === 'dev' || cmd !== 'npm') return { script: rest[0], prefix };
  return null;
}

function joinDir(base: string, rel: string): string {
  const parts = base ? base.split('/') : [];
  for (const p of rel.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

/** Whether a command runs its entry with a TypeScript runner (tsx, ts-node, …) rather than plain node. */
export function isTsRunner(command: string): boolean {
  const words = splitWords(command).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w) && w !== 'cross-env' && w !== 'npx');
  return /^(tsx|ts-node|ts-node-dev|ts-node-esm|esno|esr)$/.test(words[0] ?? '') || (words[0] === 'nodemon' && /\.[cm]?ts$/.test(words[words.length - 1] ?? ''));
}

/** The file a server runner starts (`node --watch server/index.js` → server/index.js). */
function serverEntry(leaf: Leaf): string | null {
  const [cmd, ...args] = leaf.words;
  if (!SERVER_RUNNERS.test(cmd)) return null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'watch' && positional.length === 0 && (cmd === 'tsx' || cmd === 'esno')) continue;
    // Flags that take a value.
    if (/^(--watch-path|--exec|-e|-r|--require|--import|--loader|--env-file|--inspect-port|-w|--watch|--ext|--ignore|-i|--delay|--signal|-x|--tsconfig|-P|--project)$/.test(a) && cmd !== 'node') {
      i++;
      continue;
    }
    if (/^(-r|--require|--import|--loader|--env-file)$/.test(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  return positional[0] ?? null;
}

function isVite(leaf: Leaf): boolean {
  return leaf.words[0] === 'vite' && leaf.words[1] !== 'build' && leaf.words[1] !== 'preview';
}

/** Finds the front end, the backend command and Vite's proxy rules. */
export function findFullStack(files: Files): FullStackLayout {
  const leaves: Leaf[] = [];
  for (const dir of ['', ...FRONTEND_DIRS.slice(1), ...BACKEND_DIRS]) {
    const pkg = readPackage(files, dir);
    if (!pkg) continue;
    const script = pkg.scripts.dev ?? pkg.scripts.start;
    if (script) leaves.push(...expandScript(files, dir, script));
    if (dir === '' && leaves.length) break; // the root's dev script says how the project starts
  }

  const frontend = leaves.find(isVite)?.dir ?? FRONTEND_DIRS.find((d) => text(files, d ? `${d}/index.html` : 'index.html') !== null) ?? '';
  let backend: BackendCommand | null = null;
  for (const leaf of leaves) {
    const entry = serverEntry(leaf);
    if (entry && findFile(files, leaf.dir, entry)) {
      backend = { dir: leaf.dir, main: findFile(files, leaf.dir, entry)!, command: leaf.command };
      break;
    }
  }
  // A server/ (backend/, api/) package whose own scripts were not reached from the root.
  if (!backend) {
    for (const dir of BACKEND_DIRS) {
      const pkg = readPackage(files, dir);
      const script = pkg?.scripts.dev ?? pkg?.scripts.start;
      const leaf = script ? expandScript(files, dir, script).find((l) => serverEntry(l)) : undefined;
      const entry = leaf ? serverEntry(leaf) : pkg?.main;
      if (entry && findFile(files, leaf?.dir ?? dir, entry)) {
        backend = { dir: leaf?.dir ?? dir, main: findFile(files, leaf?.dir ?? dir, entry)!, command: leaf?.command ?? `node ${entry}` };
        break;
      }
    }
  }
  return { frontend, backend, proxy: readViteProxy(files, frontend) };
}

/** The file for an entry as a runner resolves it: exact, or with a JS/TS extension or /index. */
function findFile(files: Files, dir: string, entry: string): string | null {
  const base = joinDir('', entry);
  for (const candidate of [base, ...['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].map((e) => base + e), ...['.js', '.ts'].map((e) => `${base}/index${e}`)]) {
    if (files[dir ? `${dir}/${candidate}` : candidate] !== undefined) return candidate;
  }
  return null;
}

/** server.proxy from vite.config: string targets and { target, rewrite } objects pointing at localhost. */
export function readViteProxy(files: Files, frontend: string): ProxyRule[] {
  const prefix = frontend ? `${frontend}/` : '';
  const name = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'].find((n) => typeof files[prefix + n] === 'string');
  const config = name ? text(files, prefix + name) : null;
  if (!config) return [];
  const start = /\bproxy\s*:\s*\{/.exec(config);
  if (!start) return [];
  const body = balanced(config, start.index + start[0].length - 1);
  const rules: ProxyRule[] = [];
  // Top-level keys of the proxy object and their values.
  const keyRe = /(?:^|[,{\s])(['"`])((?:\\.|(?!\1).)+)\1\s*:\s*|(?:^|[,{\s])([\w$]+)\s*:\s*/g;
  let depth = 0;
  for (let i = 1; i < body.length - 1; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (depth !== 0) continue;
    keyRe.lastIndex = i;
    const m = keyRe.exec(body);
    if (!m || m.index !== i) continue;
    const key = m[2] ?? m[3];
    let j = m.index + m[0].length;
    let value: string;
    if (body[j] === '{') {
      value = balanced(body, j);
    } else {
      const end = body.slice(j).search(/,\s*(['"`\w$])|\s*}$/);
      value = body.slice(j, end === -1 ? body.length : j + end);
    }
    i = j + value.length - 1;
    const target = /(?:target\s*:\s*)?(?:[^'"`]*\|\|\s*)?(['"`])((?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)[^'"`]*)\1/.exec(value);
    if (!target) continue;
    const rewrite = /rewrite\s*:[^]*?\.replace\(\s*\/\^?((?:\\\/|[^/])+)\/\w*\s*,\s*(['"`])\2\s*\)/.exec(value);
    rules.push({
      prefix: key.startsWith('^') ? '' : key,
      regex: key.startsWith('^') ? key : undefined,
      port: Number(target[3]),
      strip: rewrite ? rewrite[1].replace(/\\\//g, '/').replace(/^\^/, '') : undefined,
    });
  }
  return rules;
}

/** The text of the bracketed expression starting at `open`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** Whether a request path goes to the backend under `rule`, and the path it gets there. */
export function matchProxy(rules: ProxyRule[], path: string): { rule: ProxyRule; path: string } | null {
  for (const rule of rules) {
    const hit = rule.regex ? new RegExp(rule.regex).test(path) : path.startsWith(rule.prefix);
    if (!hit) continue;
    let out = path;
    if (rule.strip && out.startsWith(rule.strip)) out = out.slice(rule.strip.length) || '/';
    if (!out.startsWith('/')) out = `/${out}`;
    return { rule, path: out };
  }
  return null;
}
