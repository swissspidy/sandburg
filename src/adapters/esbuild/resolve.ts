/**
 * Module resolution for the esbuild adapter (ADR 0007), as Vite does it for the
 * browser: project-root-absolute paths, aliases, extension and index probing,
 * and node_modules packages with `exports` (conditions browser, import,
 * module, development, default), the `browser` field, `module` and `main`.
 *
 * Pure: it sees the file system only through `FileSystem`, so it runs in the
 * host page (over the project files and the node_modules index) and in tests.
 * Paths are absolute, rooted at the project directory ("/src/main.tsx",
 * "/node_modules/react/index.js").
 */

export interface FileSystem {
  isFile(path: string): boolean;
  /** Whether any file lives under `path`/. */
  isDir(path: string): boolean;
  readJson(path: string): Promise<unknown>;
}

export type Resolved = { path: string } | { empty: true; reason: string } | { external: true };

export const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'];
const CONDITIONS = ['browser', 'import', 'module', 'development', 'default'];
/** CSS imports (`@import "pkg"`) prefer the `style` condition and field, as Vite does. */
const STYLE_CONDITIONS = ['style', ...CONDITIONS];
/** Node built-ins: Vite externalizes them for the browser; here they become empty modules. */
const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls tty url util v8 vm wasi worker_threads zlib'.split(' '),
);

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  style?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
}

export class Resolver {
  private pkgCache = new Map<string, Promise<PackageJson | null>>();
  private fs: FileSystem;
  /** Prefix aliases, e.g. { '@': '/src' } (from vite.config or tsconfig paths). */
  private aliases: Record<string, string>;
  /** Package aliases, e.g. { react: 'preact/compat' } (what @preact/preset-vite sets up). */
  private packages: Record<string, string>;

  constructor(fs: FileSystem, aliases: Record<string, string> = {}, packages: Record<string, string> = {}) {
    this.fs = fs;
    this.aliases = aliases;
    this.packages = packages;
  }

  async resolve(request: string, importer: string, opts: { style?: boolean } = {}): Promise<Resolved> {
    if (/^(https?:|data:|\/\/)/.test(request)) return { external: true };
    let [bare, query] = splitQuery(request);
    if (bare in this.packages) bare = this.packages[bare];
    const dir = importer ? dirname(importer) : '/';
    const alias = this.alias(bare);
    let result: Resolved | null;
    if (alias) result = await this.file(alias, true);
    else if (bare.startsWith('/')) result = await this.file(bare, true);
    else if (bare.startsWith('.')) result = await this.file(join(dir, bare), true);
    else result = await this.bare(bare, dir, opts.style ? STYLE_CONDITIONS : CONDITIONS);
    if (result && 'path' in result) {
      // The browser field of the package that contains the file can remap it.
      result = await this.browserRemap(result.path);
      if ('path' in result && query) result = { path: result.path + query };
    }
    if (!result) throw new Error(`Could not resolve "${request}"${importer ? ` from ${importer}` : ''}`);
    return result;
  }

  private alias(request: string): string | null {
    for (const [from, to] of Object.entries(this.aliases)) {
      if (request === from) return to;
      if (request.startsWith(from.endsWith('/') ? from : `${from}/`)) return join(to, request.slice(from.replace(/\/$/, '').length + 1));
    }
    return null;
  }

  /** A file or directory: exact, with an extension, TS for .js, index files, package.json main. */
  private async file(path: string, dirOk: boolean): Promise<Resolved | null> {
    path = normalize(path);
    if (this.fs.isFile(path)) return { path };
    for (const ext of EXTENSIONS) if (this.fs.isFile(path + ext)) return { path: path + ext };
    // TypeScript sources import siblings as ".js".
    const ts = /\.(m|c)?js$/.exec(path);
    if (ts) {
      const stem = path.slice(0, -ts[0].length);
      for (const ext of ts[1] ? [`.${ts[1]}ts`] : ['.ts', '.tsx']) if (this.fs.isFile(stem + ext)) return { path: stem + ext };
    }
    if (dirOk && this.fs.isDir(path)) {
      const pkg = this.fs.isFile(`${path}/package.json`) ? await this.pkg(path) : null;
      if (pkg) {
        const main = await this.packageEntry(path, pkg);
        if (main) return main;
      }
      for (const ext of EXTENSIONS) if (this.fs.isFile(`${path}/index${ext}`)) return { path: `${path}/index${ext}` };
    }
    return null;
  }

  /** Package subpath imports ("#client/constants") from the "imports" field of the importer's package. */
  private async packageImport(request: string, fromDir: string, conditions: string[]): Promise<Resolved | null> {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      if (this.fs.isFile(`${dir === '/' ? '' : dir}/package.json`)) {
        const pkg = (await this.pkg(dir === '/' ? '' : dir)) as (PackageJson & { imports?: unknown }) | null;
        if (pkg?.imports && typeof pkg.imports === 'object') {
          const target = resolveExports(pkg.imports, request, conditions);
          if (target === null) return null;
          // A target is a path in the package ("./src/x.js") or another package ("#x": "some-pkg").
          return target.startsWith('./') ? this.file(join(dir === '/' ? '/' : dir, target), false) : this.bare(target, dir, conditions);
        }
        if (pkg) return null;
      }
      if (dir === '/') return null;
    }
  }

  private async bare(request: string, fromDir: string, conditions: string[]): Promise<Resolved | null> {
    if (request.startsWith('#')) return this.packageImport(request, fromDir, conditions);
    const name = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
    const sub = request.slice(name.length); // "" or "/x/y"
    const builtin = name.replace(/^node:/, '');
    if (request.startsWith('node:') || (NODE_BUILTINS.has(builtin) && !this.findPackageDir(name, fromDir))) {
      return { empty: true, reason: `Node.js built-in "${request}" is not available in the browser` };
    }
    const pkgDir = this.findPackageDir(name, fromDir);
    if (!pkgDir) return null;
    const pkg = await this.pkg(pkgDir);
    if (pkg?.exports !== undefined && pkg.exports !== null) {
      const target = resolveExports(pkg.exports, `.${sub}`, conditions);
      if (target === null) throw new Error(`Package subpath ".${sub}" is not exported from "${name}"`);
      return (await this.file(join(pkgDir, target), false)) ?? null;
    }
    if (!sub) return pkg ? this.packageEntry(pkgDir, pkg, conditions) : this.file(pkgDir, true);
    return this.file(join(pkgDir, `.${sub}`), true);
  }

  private findPackageDir(name: string, fromDir: string): string | null {
    let dir = fromDir;
    for (;;) {
      const candidate = `${dir === '/' ? '' : dir}/node_modules/${name}`;
      if (this.fs.isFile(`${candidate}/package.json`)) return candidate;
      if (dir === '/') return null;
      dir = dirname(dir);
    }
  }

  private async packageEntry(dir: string, pkg: PackageJson, conditions = CONDITIONS): Promise<Resolved | null> {
    if (pkg.exports !== undefined && pkg.exports !== null) {
      const target = resolveExports(pkg.exports, '.', conditions);
      if (target) return this.file(join(dir, target), false);
    }
    const browser = typeof pkg.browser === 'string' ? pkg.browser : null;
    const style = conditions.includes('style') ? pkg.style : undefined;
    for (const entry of [style, browser, pkg.module, pkg.main]) {
      if (typeof entry === 'string' && entry) {
        const found = await this.file(join(dir, entry), true);
        if (found) return found;
      }
    }
    return this.file(`${dir}/index`, false);
  }

  /** Applies a package's `browser` field object ({"./node.js": "./browser.js", "fs": false}) to a resolved file. */
  private async browserRemap(path: string): Promise<Resolved> {
    const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (!m) return { path };
    const pkg = await this.pkg(m[1]);
    if (!pkg || typeof pkg.browser !== 'object' || !pkg.browser) return { path };
    const rel = `./${path.slice(m[1].length + 1)}`;
    for (const [from, to] of Object.entries(pkg.browser)) {
      const f = normalize(join(m[1], from));
      if (f === path || EXTENSIONS.some((ext) => f + ext === path)) {
        if (to === false) return { empty: true, reason: `${rel} is disabled for the browser by its package` };
        return (await this.file(join(m[1], to), false)) ?? { path };
      }
    }
    return { path };
  }

  private pkg(dir: string): Promise<PackageJson | null> {
    let p = this.pkgCache.get(dir);
    if (!p) {
      p = this.fs.readJson(`${dir}/package.json`).then(
        (v) => (v && typeof v === 'object' ? (v as PackageJson) : null),
        () => null,
      );
      this.pkgCache.set(dir, p);
    }
    return p;
  }
}

/** Resolves a subpath ("." or "./x") against an `exports` field. Returns a "./…" target or null. */
export function resolveExports(exports: unknown, subpath: string, conditions: string[] = CONDITIONS): string | null {
  const map = exportsMap(exports);
  if (!map) return null;
  if (subpath in map) return pickTarget(map[subpath], '', conditions);
  // Patterns: "./*", "./features/*.js"; the longest matching prefix wins.
  let best: { key: string; star: string } | null = null;
  for (const key of Object.keys(map)) {
    const i = key.indexOf('*');
    if (i === -1) {
      if (key.endsWith('/') && subpath.startsWith(key) && (!best || key.length > best.key.length)) best = { key, star: subpath.slice(key.length) };
      continue;
    }
    const pre = key.slice(0, i);
    const post = key.slice(i + 1);
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1 && (!best || pre.length > best.key.indexOf('*'))) {
      best = { key, star: subpath.slice(pre.length, subpath.length - post.length) };
    }
  }
  if (!best) return null;
  const target = pickTarget(map[best.key], best.star, conditions);
  if (target === null) return null;
  return best.key.endsWith('/') && !best.key.includes('*') ? target + best.star : target;
}

function exportsMap(exports: unknown): Record<string, unknown> | null {
  if (typeof exports === 'string' || Array.isArray(exports)) return { '.': exports };
  if (!exports || typeof exports !== 'object') return null;
  const keys = Object.keys(exports);
  // Conditions at the top level (no "." keys) describe ".".
  if (keys.length && !keys.some((k) => k.startsWith('.') || k.startsWith('#'))) return { '.': exports };
  return exports as Record<string, unknown>;
}

function pickTarget(target: unknown, star: string, conditions: string[]): string | null {
  if (typeof target === 'string') return target.replaceAll('*', star);
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = pickTarget(t, star, conditions);
      if (r) return r;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [cond, value] of Object.entries(target)) {
      if (conditions.includes(cond)) {
        const r = pickTarget(value, star, conditions);
        if (r) return r;
      }
    }
  }
  return null;
}

export function splitQuery(request: string): [string, string] {
  // A leading # is a package subpath import (#client/constants), not a fragment.
  const i = request.slice(1).search(/[?#]/) + (request.slice(1).search(/[?#]/) === -1 ? 0 : 1);
  if (i === 0) return [request, ''];
  return i === -1 ? [request, ''] : [request.slice(0, i), request.slice(i)];
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function join(a: string, b: string): string {
  return normalize(b.startsWith('/') ? b : `${a}/${b}`);
}

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Path aliases from tsconfig `paths` ("@/*": ["./src/*"]) and simple vite.config `alias` entries. */
export function readAliases(files: Record<string, string | Uint8Array>): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const name of ['tsconfig.app.json', 'tsconfig.json', 'jsconfig.json']) {
    const text = files[name];
    if (typeof text !== 'string') continue;
    try {
      const json = JSON.parse(stripJsonComments(text)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const base = json.compilerOptions?.baseUrl ?? '.';
      for (const [from, [to]] of Object.entries(json.compilerOptions?.paths ?? {})) {
        if (typeof to !== 'string') continue;
        aliases[from.replace(/\/\*$/, '')] ??= join(join('/', base), to.replace(/\/\*$/, ''));
      }
    } catch {
      // not JSON(C); ignore
    }
  }
  const config = Object.entries(files).find(([p]) => /^vite\.config\.[cm]?[jt]s$/.test(p))?.[1];
  if (typeof config === 'string') {
    const re = /['"]?([@~#$\w/-]+)['"]?\s*:\s*(?:(?:path\.)?resolve\(\s*__dirname\s*,\s*|fileURLToPath\(\s*new URL\(\s*)['"]([^'"]+)['"]/g;
    for (const [, from, to] of config.matchAll(re)) aliases[from] = join('/', to);
  }
  return aliases;
}

export function stripJsonComments(text: string): string {
  // Strings are kept; // and /* */ comments and trailing commas are removed.
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
}
