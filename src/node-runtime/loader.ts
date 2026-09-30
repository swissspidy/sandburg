/**
 * node:module — a reimplementation of Node's CommonJS loader for the runtime.
 *
 * It keeps Node's public and semi-public surface (Module._load,
 * _resolveFilename, _extensions, _cache, _nodeModulePaths, wrap,
 * createRequire, builtinModules) because frameworks patch it: Next.js hooks
 * _resolveFilename to alias react to its vendored copy.
 *
 * Code is compiled before it runs (ADR 0006): node_modules files arrive
 * pre-compiled from the host; other files (the project, files generated at run
 * time such as Next.js' .next output) are compiled on demand through the host.
 */
import { Buffer } from 'buffer';
import type { Vfs } from './vfs.ts';

export interface LoaderHost {
  vfs: Vfs;
  /** Compiled code for a node_modules file, or null to compile the raw source. */
  compiledNodeModule(path: string): string | null;
  /** Compiles project or generated code (ESM → CJS, TypeScript, async lowering). */
  compile(code: string, path: string, kind: 'esm' | 'cjs' | 'ts'): string;
  builtin(name: string): unknown;
  builtinNames: string[];
  /** Names that exist only with the node: prefix (node:test, node:sqlite, …). */
  prefixOnly: Set<string>;
  process: { dlopen(m: unknown, f: string): void };
  cwd(): string;
  /** The main script path (process.argv[1]). */
  argv1(): string;
  /**
   * TypeScript runners (tsx, ts-node) resolve `./x.js` to `./x.ts` from TypeScript files, as tsc
   * does; plain Node does not.
   */
  tsRunner?: boolean;
  /** A replacement for an installed package's module (native addons such as better-sqlite3), or undefined. */
  packageOverride?(filename: string): unknown;
  /** User conditions (node --conditions), for both require and import. */
  conditions?: string[];
}

let REQUIRE_CONDITIONS = ['require', 'node', 'module-sync', 'node-addons', 'default'];
/** Conditions for `import` (ES modules are converted to CommonJS, but resolve as imports). */
let IMPORT_CONDITIONS = ['import', 'node', 'module-sync', 'node-addons', 'default'];
/** The conditions of the resolution in progress (resolution is synchronous). */
let conditions = REQUIRE_CONDITIONS;
/** First line of code compiled from an ES module (src/adapters/node/compile.ts, install.ts). */
export const ESM_MARKER = '/*sandburg:esm*/';
/** Exports objects of converted ES modules (see src/adapters/node/interop.ts). */
const esmExports: WeakSet<object> = ((globalThis as Record<symbol, unknown>)[Symbol.for('sandburg.esm')] ??= new WeakSet()) as WeakSet<object>;

interface PackageJson {
  name?: string;
  main?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
}

export function createModuleSystem(host: LoaderHost) {
  const { vfs } = host;
  if (host.conditions?.length) {
    REQUIRE_CONDITIONS = [...host.conditions, ...REQUIRE_CONDITIONS];
    IMPORT_CONDITIONS = [...host.conditions, ...IMPORT_CONDITIONS];
    conditions = REQUIRE_CONDITIONS;
  }
  const pkgCache = new Map<string, PackageJson | null>();

  const isFile = (p: string) => {
    try {
      return vfs.stat(p).kind === 'file';
    } catch {
      return false;
    }
  };
  const isDir = (p: string) => {
    try {
      return vfs.stat(p).kind === 'dir';
    } catch {
      return false;
    }
  };
  const readPackage = (dir: string): PackageJson | null => {
    const file = `${dir}/package.json`;
    if (pkgCache.has(file)) return pkgCache.get(file)!;
    let pkg: PackageJson | null = null;
    if (isFile(file)) {
      try {
        pkg = JSON.parse(new TextDecoder().decode(vfs.read(file)));
      } catch (e) {
        throw Object.assign(new Error(`Invalid package config ${file}: ${(e as Error).message}`), { code: 'ERR_INVALID_PACKAGE_CONFIG' });
      }
    }
    pkgCache.set(file, pkg);
    return pkg;
  };
  /** Nearest package.json scope of a file: [dir, pkg]. */
  const packageScope = (file: string): [string, PackageJson] | null => {
    let dir = dirname(file);
    for (;;) {
      if (basename(dir) === 'node_modules') return null;
      const pkg = readPackage(dir);
      if (pkg) return [dir, pkg];
      if (dir === '/') return null;
      dir = dirname(dir);
    }
  };

  const isBuiltin = (req: string) =>
    req.startsWith('node:') ? host.builtinNames.includes(req.slice(5)) || host.prefixOnly.has(req.slice(5)) : host.builtinNames.includes(req);

  // --- the Module class -------------------------------------------------------------------

  interface Mod {
    id: string;
    path: string;
    exports: unknown;
    filename: string | null;
    loaded: boolean;
    children: Mod[];
    paths: string[];
    parent: Mod | null | undefined;
    require(id: string): unknown;
    load(filename: string): void;
    _compile(content: string, filename: string): unknown;
    /** Compiled from an ES module: its requests resolve with import conditions. */
    esm?: boolean;
    isPreloading: boolean;
  }

  const Module = function (this: Mod, id = '', parent?: Mod | null) {
    this.id = id;
    this.path = dirname(id);
    this.exports = {};
    this.filename = null;
    this.loaded = false;
    this.children = [];
    this.paths = [];
    this.parent = parent;
    if (parent) parent.children.push(this);
  } as unknown as {
    new (id?: string, parent?: Mod | null): Mod;
    [key: string]: unknown;
    prototype: Mod;
    _cache: Record<string, Mod>;
    _pathCache: Record<string, string>;
    _extensions: Record<string, (m: Mod, filename: string) => void>;
    _load(request: string, parent: Mod | null, isMain?: boolean): unknown;
    _resolveFilename(request: string, parent: Mod | null, isMain?: boolean, options?: { paths?: string[] }): string;
    _nodeModulePaths(from: string): string[];
    _resolveLookupPaths(request: string, parent: Mod | null): string[] | null;
    _findPath(request: string, paths: string[], isMain?: boolean): string | false;
    wrapper: string[];
    wrap(code: string): string;
    createRequire(filename: string | URL): (id: string) => unknown;
    builtinModules: string[];
    isBuiltin(name: string): boolean;
    globalPaths: string[];
  };

  Module._cache = Object.create(null);
  Module._pathCache = Object.create(null);
  Module.globalPaths = [];
  Module.builtinModules = [...host.builtinNames, ...[...host.prefixOnly].map((n) => `node:${n}`)];
  Module.isBuiltin = isBuiltin;
  Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
  Module.wrap = (code: string) => Module.wrapper[0] + code + Module.wrapper[1];
  Module.Module = Module;
  Module.syncBuiltinESMExports = () => {};
  Module.register = () => {};
  Module.registerHooks = () => ({ deregister() {} });
  Module.enableCompileCache = () => ({ status: 0 });
  Module.getCompileCacheDir = () => undefined;
  Module.flushCompileCache = () => {};
  Module.findSourceMap = () => undefined;
  Module.SourceMap = class {};
  Module.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } };
  Module.findPackageJSON = (spec: string, base?: string) => {
    const scope = packageScope(base ? resolvePath(dirname(fileOf(base)), spec) : spec);
    return scope ? `${scope[0]}/package.json` : undefined;
  };
  Module.stripTypeScriptTypes = (code: string) => host.compile(code, '/strip.ts', 'ts');

  Module._nodeModulePaths = (from: string) => {
    const parts = from.split('/').filter(Boolean);
    const paths: string[] = [];
    for (let i = parts.length; i >= 0; i--) {
      if (parts[i - 1] === 'node_modules') continue;
      paths.push('/' + [...parts.slice(0, i), 'node_modules'].join('/'));
    }
    return paths;
  };

  Module._resolveLookupPaths = (request: string, parent: Mod | null) => {
    if (isBuiltin(request)) return null;
    if (request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..') {
      return [parent?.filename ? dirname(parent.filename) : '/'];
    }
    return [...(parent?.paths?.length ? parent.paths : Module._nodeModulePaths(parent?.filename ? dirname(parent.filename) : '/')), ...Module.globalPaths];
  };

  const EXTENSIONS = () => Object.keys(Module._extensions);

  const tryFile = (p: string): string | false => (isFile(p) ? p : false);
  const tryExtensions = (p: string): string | false => {
    for (const ext of EXTENSIONS()) if (isFile(p + ext)) return p + ext;
    return false;
  };
  const tryPackageMain = (dir: string): string | false => {
    const pkg = readPackage(dir);
    if (pkg?.main) {
      const main = resolvePath(dir, pkg.main);
      const found = tryFile(main) || tryExtensions(main) || tryExtensions(`${main}/index`);
      if (found) return found;
    }
    return tryExtensions(`${dir}/index`);
  };
  const tryPath = (p: string): string | false => tryFile(p) || tryExtensions(p) || (isDir(p) && tryPackageMain(p)) || false;

  Module._findPath = (request: string, paths: string[]) => {
    const key = `${conditions === IMPORT_CONDITIONS ? 'i' : 'r'}\0${request}\0${paths.join('\0')}`;
    if (Module._pathCache[key]) return Module._pathCache[key];
    if (request.startsWith('/')) {
      const found = tryPath(request);
      if (found) Module._pathCache[key] = found;
      return found;
    }
    for (const base of paths) {
      const found = tryPath(resolvePath(base, request));
      if (found) {
        Module._pathCache[key] = found;
        return found;
      }
    }
    return false;
  };

  /** Resolves a bare specifier in one node_modules directory, honoring package.json "exports". */
  const resolveInNodeModules = (nodeModules: string, request: string): string | false => {
    const [name, subpath] = splitPackage(request);
    const dir = `${nodeModules}/${name}`;
    if (!isDir(dir)) return false;
    const pkg = readPackage(dir);
    if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
      const target = resolveExports(dir, pkg.exports, `.${subpath}`, request);
      return tryFile(target) || throwNotFound(request, target);
    }
    return tryPath(`${dir}${subpath}`);
  };

  Module._resolveFilename = (request: string, parent: Mod | null, isMain?: boolean, options?: { paths?: string[] }) => {
    const previous = conditions;
    conditions = parent?.esm ? IMPORT_CONDITIONS : REQUIRE_CONDITIONS;
    try {
      return resolveFilename(request, parent, isMain, options);
    } finally {
      conditions = previous;
    }
  };
  const resolveFilename = (request: string, parent: Mod | null, _isMain?: boolean, options?: { paths?: string[] }): string => {
    if (isBuiltin(request)) return request;
    // import() of file: URLs (lowered to require) resolves like the path.
    if (request.startsWith('file://')) request = fileOf(request);
    if (request.startsWith('#')) {
      const scope = packageScope(parent?.filename ?? '/index.js');
      if (scope?.[1].imports) {
        const target = resolveImports(scope[0], scope[1].imports, request);
        if (target.startsWith('/')) return tryFile(target) || throwNotFound(request, target);
        return Module._resolveFilename(target, parent);
      }
      throw notFound(request, parent);
    }
    const relative = request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..';
    if (request.startsWith('/') || relative) {
      const bases = options?.paths ?? [parent?.filename ? dirname(parent.filename) : host.cwd()];
      const found = request.startsWith('/') ? tryPath(request) : Module._findPath(request, bases);
      if (found) return found;
      if (host.tsRunner && parent?.filename && /\.[cm]?tsx?$/.test(parent.filename)) {
        const m = /\.([cm]?)js$/.exec(request);
        if (m) {
          const stem = request.slice(0, -m[0].length);
          for (const ext of m[1] ? [`.${m[1]}ts`] : ['.ts', '.tsx']) {
            const ts = request.startsWith('/') ? tryFile(stem + ext) : Module._findPath(stem + ext, bases);
            if (ts) return ts;
          }
        }
      }
      throw notFound(request, parent);
    }
    // Package self-reference: a package importing itself by name through its "exports".
    const scope = parent?.filename ? packageScope(parent.filename) : null;
    if (scope?.[1].name && scope[1].exports && (request === scope[1].name || request.startsWith(`${scope[1].name}/`))) {
      const target = resolveExports(scope[0], scope[1].exports, `.${request.slice(scope[1].name.length)}`, request);
      if (isFile(target)) return target;
    }
    const lookup = options?.paths
      ? options.paths.flatMap((p) => Module._nodeModulePaths(p))
      : (Module._resolveLookupPaths(request, parent) ?? []);
    for (const nm of lookup) {
      const found = resolveInNodeModules(nm, request);
      if (found) return found;
    }
    throw notFound(request, parent);
  };

  function notFound(request: string, parent: Mod | null) {
    const stack: string[] = [];
    for (let m: Mod | null | undefined = parent; m; m = m.parent) if (m.filename) stack.push(m.filename);
    return Object.assign(new Error(`Cannot find module '${request}'${stack.length ? `\nRequire stack:\n- ${stack.join('\n- ')}` : ''}`), {
      code: 'MODULE_NOT_FOUND',
      requireStack: stack,
    });
  }
  function throwNotFound(request: string, target: string): never {
    throw Object.assign(new Error(`Cannot find module '${target}' (resolved from '${request}')`), { code: 'MODULE_NOT_FOUND' });
  }

  Module._load = (request: string, parent: Mod | null, isMain = false) => {
    if (isBuiltin(request)) return host.builtin(request.replace(/^node:/, ''));
    const filename = Module._resolveFilename(request, parent, isMain);
    if (isBuiltin(filename)) return host.builtin(filename.replace(/^node:/, ''));
    const override = host.packageOverride?.(filename);
    if (override !== undefined) return override;
    const cached = Module._cache[filename];
    if (cached) {
      if (parent && !parent.children.includes(cached)) parent.children.push(cached);
      return cached.exports;
    }
    const mod = new Module(filename, parent);
    if (isMain) {
      (Module as unknown as { mainModule: Mod }).mainModule = mod;
      mod.id = '.';
    }
    Module._cache[filename] = mod;
    let threw = true;
    try {
      mod.load(filename);
      threw = false;
    } finally {
      if (threw) delete Module._cache[filename];
    }
    return mod.exports;
  };

  Module.createRequire = (filename: string | URL) => {
    const file = fileOf(filename);
    const mod = new Module(file, null);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(dirname(file));
    return makeRequire(mod);
  };

  Module.runMain = (main?: string) => Module._load(main ?? host.argv1(), null, true);

  Module.prototype.require = function (this: Mod, id: string) {
    if (typeof id !== 'string') throw Object.assign(new TypeError('The "id" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' });
    return Module._load(id, this, false);
  };

  Module.prototype.load = function (this: Mod, filename: string) {
    this.filename = filename;
    this.paths = Module._nodeModulePaths(dirname(filename));
    const base = basename(filename);
    let ext = '.js';
    // Longest registered extension, as Node does (".d.ts" style multi-dot names).
    for (let i = base.indexOf('.'); i !== -1; i = base.indexOf('.', i + 1)) {
      const candidate = base.slice(i);
      if (Module._extensions[candidate]) {
        ext = candidate;
        break;
      }
    }
    Module._extensions[ext](this, filename);
    this.loaded = true;
  };

  Module.prototype._compile = function (this: Mod, content: string, filename: string) {
    const require = makeRequire(this);
    const dir = dirname(filename);
    // Web Worker globals Node lacks (self, location, importScripts) are undefined globals (worker.ts).
    const params = ['exports', 'require', 'module', '__filename', '__dirname', '__sandburg_import_meta_url'];
    const source = `(function (${params.join(', ')}) {${stripShebang(content)}\n})\n//# sourceURL=${filename}`;
    const fn = (0, eval)(source) as (...args: unknown[]) => unknown;
    if (!this.esm) return fn.call(this.exports, this.exports, require, this, filename, dir, `file://${filename}`);
    try {
      return fn.call(this.exports, this.exports, require, this, filename, dir, `file://${filename}`);
    } finally {
      if (this.exports && typeof this.exports === 'object') esmExports.add(this.exports);
    }
  };

  const readText = (filename: string) => stripBOM(new TextDecoder().decode(vfs.read(filename)));
  const inNodeModules = (f: string) => f.includes('/node_modules/');
  const looksEsm = (code: string) => /^\s*(import\s*[\w{*'"]|export\s+[\w{*]|export\s*\{)/m.test(code) || /\bimport\.meta\b/.test(code);
  const needsLowering = (code: string) => /\basync\b|\bawait\b|\beval\("/.test(code);

  const loadJs = (m: Mod, filename: string) => {
    let code: string;
    const installed = inNodeModules(filename) ? host.compiledNodeModule(filename) : null;
    if (installed !== null) {
      code = installed;
    } else {
      // Project files, and files written at run time (e.g. Vite's bundled config under node_modules/.vite-temp).
      code = readText(filename);
      const esm = filename.endsWith('.mjs') || (!filename.endsWith('.cjs') && (packageScope(filename)?.[1].type === 'module' || looksEsm(code)));
      if (esm || needsLowering(code)) code = host.compile(code, filename, esm ? 'esm' : 'cjs');
    }
    if (code.startsWith(ESM_MARKER)) m.esm = true;
    m._compile(code, filename);
  };
  const loadTs = (m: Mod, filename: string) => {
    const code = host.compile(readText(filename), filename, 'ts');
    if (code.startsWith(ESM_MARKER)) m.esm = true;
    m._compile(code, filename);
  };

  Module._extensions = Object.assign(Object.create(null), {
    '.js': loadJs,
    '.cjs': loadJs,
    '.mjs': loadJs,
    '.json': (m: Mod, filename: string) => {
      try {
        m.exports = JSON.parse(readText(filename));
      } catch (e) {
        (e as Error).message = `${filename}: ${(e as Error).message}`;
        throw e;
      }
    },
    '.node': (m: Mod, filename: string) => host.process.dlopen(m, filename),
    // Node 24 strips TypeScript types natively.
    '.ts': loadTs,
    '.cts': loadTs,
    '.mts': loadTs,
  });

  function makeRequire(mod: Mod) {
    const require = ((id: string) => mod.require(id)) as ((id: string) => unknown) & Record<string, unknown>;
    const resolve = (request: string, options?: { paths?: string[] }) => Module._resolveFilename(request, mod, false, options);
    resolve.paths = (request: string) => Module._resolveLookupPaths(request, mod);
    require.resolve = resolve;
    require.main = (Module as unknown as { mainModule?: Mod }).mainModule;
    require.extensions = Module._extensions;
    require.cache = Module._cache;
    return require;
  }

  return { Module, makeRequire, isBuiltin };

  // --- helpers that close over host ---------------------------------------------------------
}

// --- package.json "exports" / "imports" ------------------------------------------------------

function resolveExports(pkgDir: string, exports: unknown, subpath: string, request: string): string {
  let map = exports;
  // Sugar: "exports": "./x.js" or conditions object without "." keys means { ".": ... }.
  if (typeof map === 'string' || Array.isArray(map) || (map && typeof map === 'object' && !Object.keys(map).some((k) => k.startsWith('.')))) {
    map = { '.': map };
  }
  const target = matchSubpath(map as Record<string, unknown>, subpath);
  if (target === null) {
    throw Object.assign(new Error(`Package subpath '${subpath}' is not defined by "exports" in ${pkgDir}/package.json`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
  if (!target.startsWith('./')) throw Object.assign(new Error(`Invalid "exports" target "${target}" for ${request}`), { code: 'ERR_INVALID_PACKAGE_TARGET' });
  return resolvePath(pkgDir, target);
}

function resolveImports(pkgDir: string, imports: unknown, request: string): string {
  const target = matchSubpath(imports as Record<string, unknown>, request);
  if (target === null) throw Object.assign(new Error(`Package import specifier "${request}" is not defined in ${pkgDir}/package.json`), { code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED' });
  return target.startsWith('./') ? resolvePath(pkgDir, target) : target;
}

function matchSubpath(map: Record<string, unknown>, subpath: string): string | null {
  if (Object.prototype.hasOwnProperty.call(map, subpath) && !subpath.includes('*')) return resolveTarget(map[subpath], '');
  // Patterns: longest matching prefix wins.
  let best: { key: string; match: string } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1) {
      // legacy folder mapping "./dir/": "./lib/"
      if (key.endsWith('/') && subpath.startsWith(key) && (!best || key.length > best.key.length)) best = { key, match: subpath.slice(key.length) };
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      if (!best || prefix.length > best.key.indexOf('*')) best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  if (!best) return null;
  return resolveTarget(map[best.key], best.match, best.key.endsWith('/') && !best.key.includes('*'));
}

function resolveTarget(target: unknown, match: string, folder = false): string | null {
  if (typeof target === 'string') return folder ? target + match : target.replaceAll('*', match);
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveTarget(t, match, folder);
      if (r !== null) return r;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [cond, value] of Object.entries(target)) {
      if (conditions.includes(cond)) {
        const r = resolveTarget(value, match, folder);
        if (r !== null) return r;
      }
    }
  }
  return null;
}

// --- path helpers ------------------------------------------------------------------------------

function splitPackage(request: string): [string, string] {
  const parts = request.split('/');
  const n = request.startsWith('@') ? 2 : 1;
  const rest = parts.slice(n).join('/');
  return [parts.slice(0, n).join('/'), rest ? `/${rest}` : ''];
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function resolvePath(base: string, rel: string): string {
  const parts = (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function fileOf(f: string | URL): string {
  const s = String(f);
  return s.startsWith('file://') ? decodeURIComponent(new URL(s).pathname) : s;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function stripShebang(s: string): string {
  return s.startsWith('#!') ? '//' + s : s;
}

export { Buffer };
