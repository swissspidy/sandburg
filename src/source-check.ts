/**
 * The project's own sources, checked without running them (ADR 0067): a file of the app that does
 * not parse, and a package one imports that the project neither declares nor has installed. Some
 * dev servers report neither: SolidStart 2.1.0 starts streaming the page, never ends it, and logs
 * nothing. The ready phase has it checked once it has gone 20 s without the app rendering
 * (watchSources), and classify() names what it found as the cause of a ready phase that timed out.
 *
 * - Only the app's files count: those reachable from its entries (an HTML page's scripts, `main.*`,
 *   package.json's `main` and the files its dev script runs) and its frameworks' file-based roots
 *   (`app/`, `pages/`, `src/routes/`, `src/pages/`, Nuxt's auto-imported directories), following
 *   relative, aliased (tsconfig.json `paths` and `baseUrl`, `$lib`, `~`, `@`) and workspace imports.
 *   A script, an example, a test's setup or a file nothing imports is not looked at.
 * - One esbuild build per TypeScript configuration parses them (every import external, nothing
 *   written), with the project's decorator settings. A classic script that is not strict-mode code
 *   (`with`) is parsed again as a script.
 * - An undeclared import is a static `import … from` or `export … from` (not `import()` or
 *   `require()`, which an app may guard) of a package no package.json from the file up declares and
 *   no lockfile lists as installed (npm hoists what dependencies need). TypeScript's elided imports
 *   (types, and imports nothing uses) do not count, as they do not reach the dev server.
 * - Single-file components (.vue, .svelte, .astro) are checked by their scripts, each a module of its own.
 *
 * The check runs in a process of its own (checkSources), with esbuild's in its process group, a
 * time budget and lowered priority, and every file it reads is size-capped: the project's files
 * cannot hold up the host's event loop, and what the check starts ends with it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { builtinModules } from 'node:module';
import { setPriority } from 'node:os';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import type { FileTree } from './types.ts';

/** What the check found in one file, at its line (and column, for a syntax error). */
export interface SourceFinding {
  rule: 'compile-error' | 'undeclared-import';
  /** The file, relative to the project. */
  file: string;
  line: number;
  column?: number;
  /** The parser's message, or the package imported. */
  message: string;
}

export interface SourceCheckOptions {
  /** The workspace package that runs (Project.app), relative to the root; its entries are the app's. */
  app?: string;
}

/** The file:line[:column] of a finding, then what it is, as classify() reports it. */
export function describeFinding(f: SourceFinding): string {
  const at = `${f.file}:${f.line}${f.column === undefined ? '' : `:${f.column}`}`;
  return f.rule === 'compile-error' ? `${at}: ${f.message}` : `imports undeclared package "${f.message}" (${at})`;
}

const MODULE = /\.(?:[cm]?[jt]sx?)$/;
const COMPONENT = /\.(?:vue|svelte|astro)$/;
/** The extensions an import without one may mean, in the order bundlers try them. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.cts', '.vue', '.svelte', '.astro'];
/** Not the app's sources: dependencies, generated and built output, static assets, tests, their setup and stories, types. */
const SKIPPED =
  /(?:^|\/)(?:node_modules|\.[^/]+|dist|build|out|coverage|public|static|__tests__|__mocks__|tests?|e2e|cypress|playwright)\/|\.(?:test|spec|stories|story|cy)\.[^/]+$|(?:^|\/)(?:test-setup|setup-tests|setupTests|vitest\.setup|jest\.setup)\.[^/]+$|\.d\.[cm]?ts$/;
/** At most this many source files, each and every other file read at most MAX_BYTES, all of them at most MAX_TOTAL_BYTES. */
const MAX_FILES = 2_000;
const MAX_BYTES = 512 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** Brackets nested deeper than this (a crafted file) make esbuild's parser run out of stack: such a file is not parsed. */
const MAX_DEPTH = 1_000;
/** A component's scripts looked at (Vue and Svelte have two at most). */
const MAX_SCRIPTS = 16;
/** How long the check may take before it is given up (nothing found). */
const SOURCE_CHECK_BUDGET_MS = 10_000;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));
/** An npm package name, with its scope (what a bare specifier names before any subpath). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Packages a framework resolves itself, without the app declaring them. */
const PROVIDED = new Set(['server-only', 'client-only', 'styled-jsx']);
/** A stylesheet or another asset, which a bundler resolves (a virtual `uno.css`, `@unocss/reset/tailwind.css`): not checked. */
const ASSET = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|json|wasm|html?|md|mdx|txt|ya?ml|glsl|wgsl)$|\?/;
const LOADERS: Record<string, esbuild.Loader> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'jsx', mjs: 'jsx', cjs: 'jsx', jsx: 'jsx' };
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock)$/;
const CONFIG = /(?:^|\/)(?:package\.json|[tj]sconfig(?:\.[\w-]+)?\.json|[^/]*\.html?|[^/]*config\.[cm]?[jt]s|\.babelrc[^/]*)$/;

/** The argument that runs this module as the check's process (checkSources). */
const CHILD_FLAG = '--sandburg-source-check';

/**
 * Checks the project's sources in a process of its own: what checkSourcesHere finds, or nothing when
 * the check fails, takes longer than `budgetMs` or is no longer wanted (`signal`): then it is killed
 * at once, with the esbuild it started. Only the files it reads are sent, size-capped, one at a
 * time. The process runs at a lower priority, its JavaScript heap and esbuild's memory are limited,
 * and its output on stderr is dropped (esbuild's crash reports). `onSpawn` is told its process id (tests).
 */
export async function checkSources(
  files: FileTree,
  options: SourceCheckOptions = {},
  { budgetMs = SOURCE_CHECK_BUDGET_MS, signal, onSpawn }: { budgetMs?: number; signal?: AbortSignal; onSpawn?: (pid: number) => void } = {},
): Promise<SourceFinding[]> {
  if (signal?.aborted) return [];
  const sent = readable(files);
  let child: ChildProcess;
  try {
    // Its own process group (POSIX), so that esbuild's service, its child, is killed with it.
    child = spawn(process.execPath, ['--max-old-space-size=1024', fileURLToPath(import.meta.url), CHILD_FLAG, String(budgetMs)], {
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, GOMEMLIMIT: '1GiB', NODE_OPTIONS: '' },
    });
  } catch (e) {
    warn(e);
    return [];
  }
  if (child.pid !== undefined) {
    onSpawn?.(child.pid);
    try {
      setPriority(child.pid, 10);
    } catch {
      // Not allowed here: it runs at the host's priority.
    }
  }
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (found: SourceFinding[] | null, why?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (found === null) warn(why);
      resolve(found ?? []);
      kill(child);
    };
    const timer = setTimeout(() => finish(null, `it took longer than ${budgetMs} ms`), budgetMs);
    // No longer wanted (the ready phase is over): not a failure.
    const stop = () => finish([]);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.once('error', (e) => finish(null, e));
    child.once('exit', (code) => {
      try {
        finish(code === 0 ? (JSON.parse(out) as SourceFinding[]) : null, `it exited with code ${code}`);
      } catch (e) {
        finish(null, e);
      }
    });
    child.stdin!.on('error', () => {}); // a process that ends before it has read everything
    void send(child, sent, options);
  });
}

/** The check's input: its options, then one file per line, waiting while the pipe is full (no long stall of the host's thread). */
async function send(child: ChildProcess, files: FileTree, options: SourceCheckOptions): Promise<void> {
  const stdin = child.stdin!;
  const exited = new Promise((r) => child.once('exit', r));
  const write = async (line: string) => {
    if (!stdin.writable) return false;
    if (!stdin.write(`${line}\n`)) await Promise.race([new Promise((r) => stdin.once('drain', r)), exited]);
    return true;
  };
  if (!(await write(JSON.stringify(options)))) return;
  for (const [path, content] of Object.entries(files)) if (!(await write(JSON.stringify([path, content])))) return;
  stdin.end();
}

/** Ends the check's process and what it started: its process group (POSIX), its process tree (Windows). */
function kill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

let warned = false;
/** Warns once per host process that a source check failed and its findings are left out. */
function warn(why: unknown): void {
  if (warned) return;
  warned = true;
  process.emitWarning(`sandburg: a check of a project's sources failed (${why instanceof Error ? why.message : String(why)}); its findings are left out`);
}

/**
 * A text's size in bytes, as UTF-8, or `cap + 1` once it is surely over `cap`: a UTF-16 code unit is
 * at least one byte, so a text longer than `cap` is over it without being measured.
 */
function bytes(content: string, cap: number): number {
  return content.length > cap ? cap + 1 : Buffer.byteLength(content, 'utf8');
}

/** The files the check reads, as text, each within its cap and all within MAX_TOTAL_BYTES (sources first). */
function readable(files: FileTree): FileTree {
  const out: FileTree = {};
  let total = 0;
  let sources = 0;
  const take = (path: string, cap: number) => {
    const content = files[path];
    // Over what is left of the total by its length alone (a UTF-8 byte per UTF-16 unit at least): not measured.
    if (typeof content !== 'string' || total + content.length > MAX_TOTAL_BYTES) return false;
    const size = bytes(content, cap);
    if (size > cap || total + size > MAX_TOTAL_BYTES) return false;
    out[path] = content;
    total += size;
    return true;
  };
  const paths = Object.keys(files).sort();
  for (const p of paths) if ((MODULE.test(p) || COMPONENT.test(p)) && !SKIPPED.test(p) && sources < MAX_FILES && take(p, MAX_BYTES)) sources++;
  for (const p of paths) if (!/(?:^|\/)node_modules\//.test(p) && CONFIG.test(p)) take(p, MAX_BYTES);
  for (const p of paths) if (!/(?:^|\/)node_modules\//.test(p) && LOCKFILE.test(p)) take(p, MAX_LOCKFILE_BYTES);
  return out;
}

/** The text of a project's file, or null for one stored as bytes. */
function text(files: FileTree, path: string): string | null {
  const content = files[path];
  return typeof content === 'string' ? content : null;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/** `a/b/../c/./d` → `a/c/d`; null when it climbs out of the project. */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Comments out of JSON with comments (tsconfig.json), where they are not inside a string; null when it does not parse. */
function parseJsonc(source: string): unknown {
  try {
    return JSON.parse(source.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s: string | undefined) => s ?? '').replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** One `<script>` element of an HTML-like file: its attributes' text, and where its content starts and ends (equal when it has none). */
interface ScriptTag {
  attrs: string;
  from: number;
  to: number;
}

/**
 * The `<script>` elements of an HTML-like file from `start`, in one pass: an attribute's value may
 * hold `>` (Vue's `generic="T extends Record<string, unknown>"`, Astro's `define:vars={{ b: a > 0 }}`),
 * and a self-closing `<script … />` (Astro) has no content.
 */
function scriptTags(code: string, start = 0, max = Infinity): ScriptTag[] {
  const tags: ScriptTag[] = [];
  const lower = code.toLowerCase();
  let at = start;
  // The next `<script` and `<!--` from `at`, found again only once passed (one pass over the file).
  let open = -1;
  let comment = -1;
  const next = (needle: string) => {
    const found = lower.indexOf(needle, at);
    return found < 0 ? Infinity : found;
  };
  while (tags.length < max) {
    if (open < at) open = next('<script');
    if (comment < at) comment = next('<!--');
    if (open === Infinity) break;
    // A commented-out script is not one (`<!-- <script>…</script> -->`).
    if (comment < open) {
      const end = lower.indexOf('-->', comment + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    let i = open + 7;
    if (i < code.length && !/[\s/>]/.test(code[i])) {
      at = i;
      continue;
    }
    // The end of the start tag: outside quotes and braces.
    let quote = '';
    let depth = 0;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'" || (c === '`' && depth > 0)) quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
      else if (c === '>' && depth === 0) break;
    }
    if (i >= code.length) break;
    const selfClosing = code[i - 1] === '/';
    const attrs = code.slice(open + 7, selfClosing ? i - 1 : i);
    if (selfClosing) {
      tags.push({ attrs, from: i + 1, to: i + 1 });
      at = i + 1;
      continue;
    }
    const close = lower.indexOf('</script', i + 1);
    const to = close < 0 ? code.length : close;
    tags.push({ attrs, from: i + 1, to });
    at = to;
  }
  return tags;
}

/** An attribute's value in a start tag's text (`lang="ts"`, `type=module`), or undefined. */
function attribute(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}
const hasAttribute = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}(?:[\\s=]|$)`, 'i').test(attrs);

/** Whether a script element is one a bundler processes as a module or script (not JSON, a template, or one Astro leaves alone). */
function processed(tag: ScriptTag): boolean {
  const type = attribute(tag.attrs, 'type');
  if (attribute(tag.attrs, 'src') !== undefined || hasAttribute(tag.attrs, 'is:inline') || hasAttribute(tag.attrs, 'set:html')) return false;
  return !type || /^(?:module|text\/(?:java|type)script|application\/javascript)$/i.test(type);
}

/**
 * Astro's frontmatter: from the first line, `---`, to the next line that is `---` outside a string,
 * a template literal (its `${…}` too) or a comment, in one pass.
 */
function frontmatter(code: string): { from: number; to: number; end: number } | null {
  const first = /^\uFEFF?\s*---[ \t]*\r?\n/.exec(code);
  if (!first) return null;
  const from = first[0].length;
  // '`' inside a template literal, '{' inside one's `${…}` (or a brace in it).
  const stack: string[] = [];
  let lineStart = true;
  for (let i = from; i < code.length; ) {
    const c = code[i];
    if (stack.at(-1) === '`') {
      if (c === '`') stack.pop();
      else if (c === '$' && code[i + 1] === '{') stack.push('{');
      i += c === '\\' || (c === '$' && code[i + 1] === '{') ? 2 : 1;
      continue;
    }
    if (lineStart && !stack.length) {
      const close = /^---[ \t]*(?=\r?\n|$)/.exec(code.slice(i, i + 64));
      if (close) return { from, to: i, end: i + close[0].length };
    }
    lineStart = c === '\n';
    if (c === '"' || c === "'") {
      // To its closing quote, or the line's end (an unclosed one).
      for (i++; i < code.length && code[i] !== c && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
      i++;
    } else if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
    } else {
      if (c === '`') stack.push('`');
      else if (c === '{' && stack.length) stack.push('{');
      else if (c === '}' && stack.at(-1) === '{') stack.pop();
      i++;
    }
  }
  return null;
}

/** The file with everything outside [from, to) blanked (newlines kept), so a line and column in it are the file's. */
const blankOutside = (code: string, from: number, to: number) => code.slice(0, from).replace(/[^\n]/g, ' ') + code.slice(from, to) + code.slice(to).replace(/[^\n]/g, ' ');

/** A component's scripts: Vue's and Svelte's `<script>` blocks, Astro's frontmatter and its processed `<script>`s. */
function componentScripts(path: string, code: string): { code: string; loader: esbuild.Loader }[] {
  const scripts: { code: string; loader: esbuild.Loader }[] = [];
  let start = 0;
  if (path.endsWith('.astro')) {
    const front = frontmatter(code);
    if (front) {
      scripts.push({ code: blankOutside(code, front.from, front.to), loader: 'ts' });
      start = front.end;
    }
  }
  for (const tag of scriptTags(code, start, MAX_SCRIPTS)) {
    if (!processed(tag) || tag.from === tag.to) continue;
    const lang = attribute(tag.attrs, 'lang') ?? (path.endsWith('.astro') || /typescript/i.test(attribute(tag.attrs, 'type') ?? '') ? 'ts' : 'js');
    scripts.push({ code: blankOutside(code, tag.from, tag.to), loader: LOADERS[lang] ?? 'ts' });
  }
  return scripts;
}

/**
 * Astro's frontmatter may `return` (Astro.redirect), which no module may: each top-level `return`
 * esbuild reports is replaced by `if(1) `, of the same length, until none is left.
 */
async function astroReturns(code: string, loader: esbuild.Loader): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const errors = await esbuild.transform(code, { loader, logLevel: 'silent' }).then(
      () => [],
      (e: esbuild.TransformFailure) => e.errors ?? [],
    );
    const returns = errors.filter((e) => e.text.startsWith('Top-level return cannot be used') && e.location);
    if (!returns.length) return code;
    const lines = code.split('\n');
    for (const { location } of returns) {
      const line = lines[location!.line - 1];
      if (line.slice(location!.column, location!.column + 6) === 'return') lines[location!.line - 1] = line.slice(0, location!.column) + 'if(1) ' + line.slice(location!.column + 6);
    }
    const next = lines.join('\n');
    if (next === code) return code;
    code = next;
  }
  return code;
}

/** What a tsconfig.json (with what it extends, in the project) says that the check needs. */
interface TsConfig {
  /** The options esbuild reads (decorators, class fields, import elision, JSX). */
  esbuild: Record<string, unknown>;
  /** `baseUrl`, as a directory of the project ('' for its root), or null. */
  baseUrl: string | null;
  /** `paths`: a pattern (`@/*`) and its first target (`src/*`), relative to the project. */
  paths: [string, string][];
  /** It extends a config that is not in the project (a package's): its options are not all known. */
  unresolved?: true;
}

const ESBUILD_OPTIONS = ['experimentalDecorators', 'emitDecoratorMetadata', 'useDefineForClassFields', 'verbatimModuleSyntax', 'preserveValueImports', 'importsNotUsedAsValues', 'jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource', 'target'];

/** The tsconfig.json (or jsconfig.json) nearest a file, read with what it extends within the project. */
function tsconfigs(files: FileTree): (file: string) => TsConfig {
  type Json = { extends?: string | string[]; compilerOptions?: Record<string, unknown>; references?: { path?: unknown }[]; include?: unknown; files?: unknown };
  const cache = new Map<string, TsConfig>();
  const json = (path: string) => parseJsonc(text(files, path) ?? '') as Json | null;
  /** A config a path names: the file, with `.json`, or a directory's tsconfig.json. */
  const named = (target: string | null) => (target === null ? null : ([target, `${target}.json`, `${target}/tsconfig.json`].find((p) => text(files, p) !== null) ?? null));
  const read = (path: string, depth: number): TsConfig => {
    const config = depth > 8 ? null : json(path);
    if (!config) return { esbuild: {}, baseUrl: null, paths: [], unresolved: true };
    let base: TsConfig = { esbuild: {}, baseUrl: null, paths: [] };
    for (const extended of [config.extends ?? []].flat()) {
      if (typeof extended !== 'string') continue;
      // A package's config (`@tsconfig/svelte`), or one not in the project: what it sets is not known.
      const file = extended.startsWith('.') ? named(normalize(dirOf(path) + extended)) : null;
      const unresolved = base.unresolved;
      base = file ? read(file, depth + 1) : { ...base, unresolved: true };
      if (unresolved) base = { ...base, unresolved };
    }
    const options = config.compilerOptions ?? {};
    const dir = dirOf(path);
    const esbuildOptions = { ...base.esbuild };
    for (const key of ESBUILD_OPTIONS) if (key in options) esbuildOptions[key] = options[key];
    const baseUrl = typeof options.baseUrl === 'string' ? normalize(dir + options.baseUrl) : base.baseUrl;
    let paths = base.paths;
    if (options.paths && typeof options.paths === 'object') {
      // Targets are relative to baseUrl, else to the config's directory.
      const root = baseUrl ?? dir;
      paths = Object.entries(options.paths as Record<string, unknown>).flatMap(([pattern, targets]) => {
        const target = Array.isArray(targets) && typeof targets[0] === 'string' ? normalize(`${root}/${targets[0]}`) : null;
        return target === null ? [] : [[pattern, target] as [string, string]];
      });
    }
    return { esbuild: esbuildOptions, baseUrl, paths, ...(base.unresolved ? { unresolved: true } : {}) };
  };
  const cached = (path: string) => {
    let config = cache.get(path);
    if (!config) cache.set(path, (config = read(path, 0)));
    return config;
  };
  /** Whether a config's `files` or `include` (default: everything under it) covers a file, as tsc reads them. */
  const covers = (path: string, file: string) => {
    const config = json(path);
    const dir = dirOf(path);
    if (!file.startsWith(dir)) return false;
    const rel = file.slice(dir.length);
    if (Array.isArray(config?.files) && config.files.some((f) => typeof f === 'string' && normalize(dir + f) === file)) return true;
    const include = Array.isArray(config?.include) ? config.include : config?.files ? [] : ['**/*'];
    return include.some((pattern) => {
      if (typeof pattern !== 'string') return false;
      const glob = normalize(pattern) ?? '';
      // A directory (no wildcard, no extension) means everything under it.
      return /[*?]/.test(glob) || /\.[^/]+$/.test(glob) ? matchesGlob(rel, glob) || matchesGlob(rel, glob.replace(/\/\*$/, '/**/*')) : rel.startsWith(`${glob}/`) || glob === '';
    });
  };
  return (file) => {
    for (let dir = dirOf(file); ; dir = dirOf(dir.slice(0, -1))) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const path = dir + name;
        if (text(files, path) === null) continue;
        // A solution-style config (Vite's): the referenced config that covers the file.
        const references = json(path)?.references;
        if (Array.isArray(references)) {
          for (const ref of references) {
            const referenced = typeof ref?.path === 'string' ? named(normalize(dir + ref.path)) : null;
            if (referenced && covers(referenced, file)) return cached(referenced);
          }
        }
        return cached(path);
      }
      if (!dir) return { esbuild: {}, baseUrl: null, paths: [] };
    }
  };
}

/** The packages lockfiles list as installed where a file may import them: hoisted (npm, yarn), listed (pnpm, bun). */
function installedPackages(files: FileTree): (file: string) => Set<string> {
  const everywhere = new Set<string>();
  const under = new Map<string, Set<string>>();
  for (const path of Object.keys(files)) {
    if (!LOCKFILE.test(path)) continue;
    const source = text(files, path);
    if (source === null) continue;
    const dir = dirOf(path);
    const add = (prefix: string, name: string) => {
      const set = under.get(prefix) ?? new Set<string>();
      set.add(name);
      under.set(prefix, set);
    };
    if (/(?:package-lock|npm-shrinkwrap)\.json$/.test(path)) {
      const lock = parseJsonc(source) as { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> } | null;
      for (const key of Object.keys(lock?.packages ?? {})) {
        // node_modules/x (hoisted at the root), or packages/web/node_modules/x (a workspace's own).
        const m = /^((?:[^/]+\/)*?)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
        if (m && !m[1].includes('node_modules/')) add(dir + m[1], m[2]);
      }
      for (const name of Object.keys(lock?.dependencies ?? {})) add(dir, name); // lockfileVersion 1: the top level is hoisted
    } else if (path.endsWith('yarn.lock')) {
      for (const line of source.split('\n')) {
        if (!line || /^[\s#]/.test(line) || !line.endsWith(':')) continue;
        for (const entry of line.slice(0, -1).split(',')) {
          const descriptor = entry.trim().replace(/^"|"$/g, '');
          const at = descriptor.indexOf('@', 1);
          if (at > 0) everywhere.add(descriptor.slice(0, at));
        }
      }
    } else if (path.endsWith('pnpm-lock.yaml')) {
      let inPackages = false;
      for (const line of source.split('\n')) {
        if (/^\S/.test(line)) inPackages = /^(?:packages|snapshots):/.test(line);
        // `name@1.0.0:` (lockfile v6 and later), `/name/1.0.0:` (v5).
        const m = inPackages ? (/^ {2}'?\/?((?:@[^/@'\s]+\/)?[^/@'\s(]+)@/.exec(line) ?? /^ {2}'?\/((?:@[^/@'\s]+\/)?[^/@'\s(]+)\/\d/.exec(line)) : null;
        if (m) everywhere.add(m[1]);
      }
    } else {
      const lock = parseJsonc(source) as { packages?: Record<string, unknown> } | null;
      for (const key of Object.keys(lock?.packages ?? {})) everywhere.add(key.split('/node_modules/').at(-1)!.replace(/^((?:@[^/]+\/)?[^/]+).*$/, '$1'));
    }
  }
  return byDirectory((dir) => {
    const found = new Set(everywhere);
    for (const [prefix, names] of under) if (dir.startsWith(prefix)) for (const n of names) found.add(n);
    return found;
  });
}

/** `of(dir)` for a file's directory, made once per directory. */
function byDirectory<T>(of: (dir: string) => T): (file: string) => T {
  const cache = new Map<string, T>();
  return (file) => {
    const dir = dirOf(file);
    let value = cache.get(dir);
    if (value === undefined) cache.set(dir, (value = of(dir)));
    return value;
  };
}

/**
 * What a file may import without declaring it: the dependencies of each package.json from its
 * directory up to the project's root, the workspace packages, an import map's names (a static app's
 * `<script type="importmap">`), and names quoted or used as keys in the build tools' configs (an
 * alias in vite.config.ts).
 */
function declaredFor(files: FileTree): { declared: (file: string) => Set<string>; workspaces: Map<string, string> } {
  const shared = new Set<string>();
  const manifests = new Map<string, Set<string>>();
  const workspaces = new Map<string, string>();
  for (const path of Object.keys(files)) {
    const source = text(files, path);
    if (source === null || !CONFIG.test(path)) continue;
    const name = path.split('/').at(-1)!;
    if (name === 'package.json') {
      const pkg = parseJsonc(source) as Record<string, unknown> | null;
      if (!pkg) continue;
      const deps = new Set<string>();
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const dep of Object.keys((pkg[field] as object | undefined) ?? {})) deps.add(dep);
      manifests.set(dirOf(path), deps);
      if (typeof pkg.name === 'string') {
        shared.add(pkg.name);
        workspaces.set(pkg.name, dirOf(path));
      }
    } else if (/\.html?$/.test(name)) {
      for (const tag of scriptTags(source, 0, 256)) {
        if (attribute(tag.attrs, 'type')?.toLowerCase() !== 'importmap') continue;
        const map = parseJsonc(source.slice(tag.from, tag.to)) as { imports?: object; scopes?: Record<string, object> } | null;
        for (const key of [...Object.keys(map?.imports ?? {}), ...Object.values(map?.scopes ?? {}).flatMap((s) => Object.keys(s))]) shared.add(key.replace(/\/$/, ''));
      }
    } else if (/config\.[cm]?[jt]s$|^\.babelrc/.test(name)) {
      for (const m of source.matchAll(/(["'`])([^"'`\s]{1,100})\1|\b([\w@$~-]{1,100})\s{0,10}:/g)) shared.add((m[2] ?? m[3]).replace(/\/$/, ''));
    }
  }
  return {
    declared: byDirectory((file) => {
      const declared = new Set(shared);
      for (const [dir, deps] of manifests) if (file.startsWith(dir)) for (const d of deps) declared.add(d);
      return declared;
    }),
    workspaces,
  };
}

/** The package a bare specifier names, or null for anything else (a relative path, a URL, an alias, a built-in, an asset). */
function packageOf(specifier: string): string | null {
  // Relative, absolute, a scheme (node:, virtual:, astro:, https:), subpath imports (#) and aliases (~, $lib, @/).
  if (/^[./#~$]|^@\/|^[a-z][a-z0-9+.-]*:/i.test(specifier) || ASSET.test(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return PACKAGE_NAME.test(name) && !BUILTINS.has(name) && !PROVIDED.has(name) ? name : null;
}

/** Whether a package is declared, or a configured alias covers the specifier. */
function isDeclared(specifier: string, pkg: string, declared: Set<string>): boolean {
  if (declared.has(pkg)) return true;
  for (let at = specifier.length; at > 0; at = specifier.lastIndexOf('/', at - 1)) if (declared.has(specifier.slice(0, at))) return true;
  return false;
}

/** The line of a file's first static import of `specifier` (1 when it is not found as written). */
function importLine(code: string, specifier: string): number {
  const quoted = new RegExp(`\\b(?:from|import)\\s*(["'])${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\1`);
  const m = quoted.exec(code);
  return m ? code.slice(0, m.index).split('\n').length : 1;
}

/** The app's roots, in `app` (a directory of the project, '' or ending in '/'): files whose every module is the app's. */
function roots(files: FileTree, sources: string[], app: string): Set<string> {
  const has = (p: string) => p in files;
  const config = (name: string) => ['js', 'mjs', 'cjs', 'ts', 'mts'].some((e) => has(`${app}${name}.config.${e}`));
  const dirs = ['app/', 'pages/', 'src/routes/', 'src/pages/'];
  if (config('next')) dirs.push('src/app/');
  // Nuxt imports these directories' files itself (components, composables), at the root or in app/ (Nuxt 4).
  if (config('nuxt')) for (const base of ['', 'app/']) for (const d of ['components', 'composables', 'utils', 'layouts', 'pages', 'plugins', 'middleware', 'server']) dirs.push(`${base}${d}/`);
  const found = new Set<string>();
  for (const file of sources) {
    if (!file.startsWith(app)) continue;
    const rel = file.slice(app.length);
    if (
      dirs.some((d) => rel.startsWith(d)) ||
      /^(?:src\/)?main\.[^./]+$/.test(rel) ||
      /^(?:src\/)?(?:index|entry-client|entry-server|app|hooks(?:\.server|\.client)?|middleware|server)\.[cm]?[jt]sx?$/.test(rel) ||
      /^(?:app\/)?(?:app|error)\.vue$/.test(rel)
    )
      found.add(file);
  }
  // An HTML page's scripts (`/src/main.ts` from the app's root, `js/main.js` from the page).
  for (const page of Object.keys(files).filter((p) => p.startsWith(app) && /\.html?$/.test(p) && !SKIPPED.test(p))) {
    for (const tag of scriptTags(text(files, page) ?? '', 0, 256)) {
      const src = attribute(tag.attrs, 'src');
      if (!src || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) continue;
      const path = normalize(src.startsWith('/') ? app + src.slice(1) : dirOf(page) + src.replace(/[?#].*$/, ''));
      if (path !== null && has(path)) found.add(path);
    }
  }
  // package.json's main, and the project's files its dev and start scripts name (`node server.js`, `tsx watch src/server.ts`).
  const pkg = parseJsonc(text(files, `${app}package.json`) ?? '') as { main?: unknown; module?: unknown; scripts?: Record<string, unknown> } | null;
  for (const entry of [pkg?.main, pkg?.module]) if (typeof entry === 'string') for (const p of candidates(normalize(app + entry))) if (has(p)) found.add(p);
  for (const script of [pkg?.scripts?.dev, pkg?.scripts?.start, pkg?.scripts?.serve]) {
    if (typeof script !== 'string') continue;
    for (const word of script.split(/[\s&|;]+/)) {
      const path = normalize(app + word.replace(/^['"]|['"]$/g, ''));
      if (path !== null && MODULE.test(path) && has(path)) found.add(path);
    }
  }
  return found;
}

/** The files an import of `path` may mean: itself, with an extension, its index, or TypeScript's `.ts` for a `.js`. */
function candidates(path: string | null): string[] {
  if (path === null) return [];
  const out = [path, ...EXTENSIONS.map((e) => path + e), ...EXTENSIONS.map((e) => `${path}/index${e}`)];
  const js = /\.([cm]?)jsx?$/.exec(path);
  if (js) out.push(path.slice(0, -js[0].length) + `.${js[1]}ts`, path.slice(0, -js[0].length) + `.${js[1]}tsx`);
  return out;
}

/** Resolves imports to the project's files: relative, from the app's root (`/src/x`), aliased, and of workspace packages. */
function resolver(files: FileTree, app: string, tsconfigFor: (file: string) => TsConfig, workspaces: Map<string, string>) {
  const has = (p: string) => p in files;
  const nuxt = ['js', 'mjs', 'ts'].some((e) => has(`${app}nuxt.config.${e}`));
  const srcDir = nuxt && Object.keys(files).some((p) => p.startsWith(`${app}app/`)) ? `${app}app/` : app;
  const first = (paths: (string | null)[]) => paths.flatMap(candidates).find(has) ?? null;
  /** The names at the top of a `baseUrl` directory (`components`, `lib`, `utils.ts` as `utils`). */
  const tops = new Map<string, Set<string>>();
  const topsOf = (base: string) => {
    let names = tops.get(base);
    if (!names) {
      names = new Set();
      for (const p of Object.keys(files)) if (p.startsWith(base) && !p.slice(base.length).startsWith('node_modules/')) names.add(p.slice(base.length).split('/')[0].replace(/\.[^.]+$/, ''));
      tops.set(base, names);
    }
    return names;
  };
  /** A `#name` import by the `imports` of the package.json nearest the importer (`"#lib/*": "./src/lib/*"`). */
  const subpathImport = (importer: string, spec: string): string | null => {
    for (let dir = dirOf(importer); ; dir = dirOf(dir.slice(0, -1))) {
      const manifest = text(files, `${dir}package.json`);
      if (manifest !== null) {
        const map = (parseJsonc(manifest) as { imports?: Record<string, unknown> } | null)?.imports ?? {};
        for (const [pattern, value] of Object.entries(map)) {
          const target = conditional(value);
          const star = pattern.indexOf('*');
          if (!target || (star < 0 ? spec !== pattern : !spec.startsWith(pattern.slice(0, star)) || !spec.endsWith(pattern.slice(star + 1)))) continue;
          return normalize(dir + target.replace('*', star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1))));
        }
        return null;
      }
      if (!dir) return null;
    }
  };
  /** The file an import names, or null; `alias` says whether the specifier is the project's own (an alias, `baseUrl`), found or not. */
  return (importer: string, specifier: string): { file: string | null; alias: boolean } => {
    const spec = specifier.replace(/(?!^)[?#].*$/, '');
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return { file: first([normalize(dirOf(importer) + spec)]), alias: true };
    if (spec.startsWith('/')) return { file: first([normalize(app + spec.slice(1))]), alias: true };
    if (spec.startsWith('$lib/') || spec === '$lib') return { file: first([normalize(`${app}src/lib/${spec.slice(5)}`)]), alias: true };
    if (spec.startsWith('#')) return { file: first([subpathImport(importer, spec)]), alias: true };
    if (/^[~@]{2}\//.test(spec)) return { file: first([normalize(app + spec.slice(3))]), alias: true };
    const config = tsconfigFor(importer);
    for (const [pattern, target] of config.paths) {
      const star = pattern.indexOf('*');
      if (star < 0 ? spec !== pattern : !spec.startsWith(pattern.slice(0, star)) || !spec.endsWith(pattern.slice(star + 1))) continue;
      const middle = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
      return { file: first([normalize(target.replace('*', middle))]), alias: true };
    }
    if (/^[~@]\//.test(spec)) return { file: first([normalize(srcDir + spec.slice(2)), normalize(`${app}src/${spec.slice(2)}`)]), alias: true };
    // Under baseUrl: `components/x` when the base has a `components` directory or file.
    if (config.baseUrl !== null) {
      const base = config.baseUrl ? `${config.baseUrl}/` : '';
      if (topsOf(base).has(spec.split('/')[0])) return { file: first([normalize(base + spec)]), alias: true };
    }
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const dir = workspaces.get(pkg);
    if (dir !== undefined) {
      const sub = spec.slice(pkg.length + 1);
      if (sub) return { file: first([normalize(dir + sub), normalize(`${dir}src/${sub}`)]), alias: false };
      const manifest = parseJsonc(text(files, `${dir}package.json`) ?? '') as { main?: unknown; module?: unknown; exports?: unknown; source?: unknown } | null;
      const exp = manifest?.exports;
      const dot = exp && typeof exp === 'object' && !Array.isArray(exp) && '.' in exp ? (exp as Record<string, unknown>)['.'] : exp;
      const entries = [manifest?.source, conditional(dot), manifest?.module, manifest?.main];
      return { file: first([...entries.filter((e): e is string => typeof e === 'string').map((e) => normalize(dir + e)), normalize(`${dir}src/index`), normalize(`${dir}index`)]), alias: false };
    }
    return { file: null, alias: false };
  };
}

/** The path a package.json `exports` or `imports` value gives: a string, or the first of its conditions that is one. */
function conditional(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return conditional(value[0]);
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const key of ['import', 'module', 'browser', 'default', ...Object.keys(v)]) if (key in v && !key.startsWith('.') && key !== 'types') {
      const found = conditional(v[key]);
      if (found) return found;
    }
  }
  return null;
}

/** A module esbuild parses: a file, or one of a component's scripts (`<file>?script=<n>`). */
interface Module {
  file: string;
  code: string;
  loader: esbuild.Loader;
}

/** Parses `modules` with one esbuild build: each module's errors, and its imports (`kind` as esbuild names it). */
async function parse(modules: Map<string, Module>, tsconfigRaw: string): Promise<{ errors: esbuild.Message[]; imports: { id: string; specifier: string; kind: string }[] }> {
  const imports: { id: string; specifier: string; kind: string }[] = [];
  const errors = await esbuild
    .build({
      entryPoints: [...modules.keys()],
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
      jsx: 'preserve',
      tsconfigRaw,
      plugins: [
        {
          name: 'project-sources',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'entry-point') return { path: args.path, namespace: 'project' };
              imports.push({ id: args.importer, specifier: args.path, kind: args.kind });
              return { path: args.path, external: true };
            });
            build.onLoad({ filter: /.*/, namespace: 'project' }, (args) => {
              const m = modules.get(args.path)!;
              return { contents: m.code, loader: m.loader };
            });
          },
        },
      ],
    })
    .then(
      () => [] as esbuild.Message[],
      (e: esbuild.BuildFailure) => e.errors ?? [],
    );
  return { errors, imports };
}

/** Whether brackets nest deeper than MAX_DEPTH anywhere in `code` (counted as written, strings and comments too: one pass). */
function nestedTooDeep(code: string): boolean {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    // ( [ {  and  ) ] }
    if (c === 40 || c === 91 || c === 123) {
      if (++depth > MAX_DEPTH) return true;
    } else if ((c === 41 || c === 93 || c === 125) && depth > 0) depth--;
  }
  return false;
}

/** esbuild's errors for legacy (experimentalDecorators) decorators. */
const LEGACY_DECORATORS = /^(?:Parameter decorators only work when experimental decorators are enabled|Decorators are not valid here)/;

/** Whether a module parses on its own with these options (and as a script: no ESM output). */
const parses = (module: Module, options: esbuild.TransformOptions) => esbuild.transform(module.code, { loader: module.loader, logLevel: 'silent', ...options }).then(() => true, () => false);

/** Errors that only the ESM output's strict mode makes (a classic script's `with`): parsed again as a script, they may be none. */
const STRICT_ONLY = /output format due to strict mode|cannot be used in strict mode|in strict mode code/;

/** Checks the project's sources here, on this thread (checkSources runs it on a thread of its own). */
export async function checkSourcesHere(files: FileTree, options: SourceCheckOptions = {}): Promise<SourceFinding[]> {
  const app = options.app ? `${options.app.replace(/\/+$/, '')}/` : '';
  const sources = Object.keys(files)
    .filter((p) => (MODULE.test(p) || COMPONENT.test(p)) && !SKIPPED.test(p) && text(files, p) !== null && bytes(text(files, p)!, MAX_BYTES) <= MAX_BYTES)
    .sort()
    .slice(0, MAX_FILES);
  const tsconfigFor = tsconfigs(files);
  const { declared, workspaces } = declaredFor(files);
  const installed = installedPackages(files);
  const resolve = resolver(files, app, tsconfigFor, workspaces);

  // Each module, grouped by the TypeScript options it is parsed with.
  const groups = new Map<string, Map<string, Module>>();
  for (const file of sources) {
    const code = text(files, file)!;
    if (nestedTooDeep(code)) continue;
    // A component's compiler keeps the imports its template uses, which TypeScript would elide from its script.
    // (preserveValueImports keeps every value import and drops those of types only: `import { type X } from 'csstype'`.)
    const raw = JSON.stringify({ compilerOptions: { ...tsconfigFor(file).esbuild, ...(COMPONENT.test(file) ? { verbatimModuleSyntax: false, preserveValueImports: true } : {}) } });
    const group = groups.get(raw) ?? new Map<string, Module>();
    groups.set(raw, group);
    if (MODULE.test(file)) group.set(file, { file, code, loader: LOADERS[file.split('.').at(-1)!] });
    else
      for (const [i, s] of componentScripts(file, code).entries()) {
        const m = { file, ...s };
        group.set(`${file}?script=${i}`, file.endsWith('.astro') ? { ...m, code: await astroReturns(m.code, m.loader) } : m);
      }
  }
  const modules = new Map<string, Module>();
  const errors: { module: Module; error: esbuild.Message }[] = [];
  const imports: { module: Module; specifier: string; kind: string }[] = [];
  for (const [raw, group] of groups) {
    if (!group.size) continue;
    const parsed = await parse(group, raw);
    for (const [id, m] of group) modules.set(id, m);
    for (const error of parsed.errors) {
      const m = group.get(error.location?.file.replace(/^project:/, '') ?? '');
      if (m && error.location) errors.push({ module: m, error });
    }
    for (const i of parsed.imports) {
      const m = group.get(i.id);
      if (m) imports.push({ module: m, specifier: i.specifier, kind: i.kind });
    }
  }

  // The app's files: its roots, and what they import, transitively.
  const edges = new Map<string, Set<string>>();
  for (const { module, specifier } of imports) {
    const target = resolve(module.file, specifier).file;
    if (target) edges.set(module.file, (edges.get(module.file) ?? new Set()).add(target));
  }
  const reachable = roots(files, sources, app);
  for (const file of reachable) for (const next of edges.get(file) ?? []) reachable.add(next);

  const findings: SourceFinding[] = [];
  const broken = new Set<string>();
  for (const { module, error } of errors) {
    if (!reachable.has(module.file) || broken.has(module.file)) continue;
    // A classic script's sloppy-mode code: parsed as a script, it may have no error.
    if (STRICT_ONLY.test(error.text) && (await parses(module, {}))) continue;
    // Legacy decorators, in a project whose config extends one not in it (a package's), which may turn them on.
    if (LEGACY_DECORATORS.test(error.text) && tsconfigFor(module.file).unresolved && (await parses(module, { tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } }))) continue;
    broken.add(module.file);
    findings.push({ rule: 'compile-error', file: module.file, line: error.location!.line, column: error.location!.column + 1, message: error.text });
  }
  const reported = new Set<string>();
  for (const { module, specifier, kind } of imports) {
    if (kind !== 'import-statement' || !reachable.has(module.file) || broken.has(module.file)) continue;
    const pkg = packageOf(specifier);
    if (!pkg || reported.has(`${module.file}\0${pkg}`) || resolve(module.file, specifier).alias || isDeclared(specifier, pkg, declared(module.file)) || installed(module.file).has(pkg)) continue;
    reported.add(`${module.file}\0${pkg}`);
    findings.push({ rule: 'undeclared-import', file: module.file, line: importLine(module.code, specifier), message: pkg });
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/** The check's process: reads its input (send), checks, stops esbuild, writes what it found, exits; on its own after its budget. */
async function child(budgetMs: number): Promise<void> {
  setTimeout(() => process.exit(3), budgetMs + 1_000).unref();
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk as string;
  const [first, ...rest] = text.split('\n').filter(Boolean);
  const files: FileTree = {};
  for (const line of rest) {
    const [path, content] = JSON.parse(line) as [string, string];
    files[path] = content;
  }
  const found = await checkSourcesHere(files, JSON.parse(first) as SourceCheckOptions);
  // esbuild's service ends once stopped; this process waits for it (and so reaps it) before it ends.
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 100));
  process.stdout.write(JSON.stringify(found), () => process.exit(0));
}

if (process.argv[2] === CHILD_FLAG && process.argv[1] === fileURLToPath(import.meta.url)) {
  child(Number(process.argv[3])).catch(() => process.exit(1));
}
