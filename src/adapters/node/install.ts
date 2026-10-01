/**
 * Host-side dependency installation for the node runtime (ADR 0006).
 *
 * npm runs on the host with --ignore-scripts: it only resolves and downloads
 * files; no package code runs outside the browser. Installs are cached by a
 * key over the dependency declarations and lockfile, so batches share them.
 * The browser reads node_modules lazily through the host server, with
 * JavaScript pre-compiled for the runtime (ESM → CommonJS, async/await
 * lowered so AsyncLocalStorage works; see src/node-runtime/async-context.ts).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { access, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import { hasTopLevelAwait, toAsyncModule } from './tla.ts';
import { renameCommonJsNames } from './esm-names.ts';
import { esmSourcefile, patchAsyncFunction, patchFunctionImport, patchInterop } from './interop.ts';
import type { Project } from '../../types.ts';

/** Bump when the transform changes, so cached transforms are rebuilt. */
export const TRANSFORM_VERSION = 10;
/** Bump when what an install contains changes (e.g. WebAssembly bindings added), so installs are redone. */
const LAYOUT_VERSION = 14;

export interface InstallInfo {
  key: string;
  dir: string;
  /** Resolved versions of direct dependencies (from node_modules/<name>/package.json). */
  resolved: Record<string, string>;
  lockfile: boolean;
  fromCache: boolean;
}

/** Path (relative to node_modules' parent) → size; directories are implied. */
export type FileIndex = Record<string, number>;

/** The install cache shared by the adapters that install npm dependencies on the host (node, esbuild). */
export function sharedInstaller(): Installer {
  return (shared ??= new Installer(resolve(process.env.SANDBURG_INSTALL_DIR ?? '.sandburg/installs')));
}
let shared: Installer | undefined;

/** A name for a temporary file no other write uses, even of the same file at the same time. */
export const tmpSuffix = () => `${process.pid}-${randomBytes(6).toString('hex')}`;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: unknown;
}

export class Installer {
  readonly root: string;
  private pending = new Map<string, Promise<InstallInfo>>();
  private indexes = new Map<string, Promise<FileIndex>>();
  private combined = new Map<string, { dir: string; key: string }[]>();

  constructor(root: string) {
    this.root = root;
    void this.sweep();
  }

  /**
   * Removes installs of an earlier layout (LAYOUT_VERSION) that have not changed for a day: their
   * keys are never asked for again.
   * An install records its layout in .sandburg-complete; one without the record is left alone.
   */
  private async sweep(): Promise<void> {
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{24}$/.test(name)) continue;
      const done = await readFile(join(this.root, name, '.sandburg-complete'), 'utf8').catch(() => '');
      const layout = /layout (\d+)/.exec(done)?.[1];
      // A day without changes (new transforms are written into an install as it is used), so another
      // Sandburg process still on that layout is not using it.
      const idle = Date.now() - ((await lstat(join(this.root, name)).catch(() => null))?.mtimeMs ?? Date.now()) > 24 * 3600_000;
      if (layout && Number(layout) !== LAYOUT_VERSION && idle) await rm(join(this.root, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The install of `project`'s dependencies plus `extra`: its key, npm's manifest and the lockfile. */
  private plan(project: Project, extra: Record<string, string>): { key: string; manifest: object; lock: string | null } {
    const pkg = project.packageJson ?? {};
    const lockFile = project.files['package-lock.json'];
    const lock = typeof lockFile === 'string' ? lockFile : null;
    const manifest = {
      name: 'sandburg-install',
      private: true,
      dependencies: { ...(pkg.dependencies as Record<string, string>), ...extra },
      devDependencies: pkg.devDependencies ?? {},
      overrides: pkg.overrides,
    };
    const key = createHash('sha256')
      .update(`layout:${LAYOUT_VERSION}\0`)
      .update(JSON.stringify(manifest))
      .update(lock ?? '')
      .digest('hex')
      .slice(0, 24);
    return { key, manifest, lock };
  }

  /** Whether `project`'s install (plus `extra`) is finished and cached. */
  installed(project: Project, extra: Record<string, string>): Promise<boolean> {
    return access(join(this.root, this.plan(project, extra).key, '.sandburg-complete')).then(() => true, () => false);
  }

  /** Installs `project`'s dependencies plus `extra` (name → spec) unless already cached. */
  install(project: Project, extra: Record<string, string>, log: (line: string) => void): Promise<InstallInfo> {
    const { key, manifest, lock } = this.plan(project, extra);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.doInstall(key, manifest, lock, log);
      this.pending.set(key, pending);
      pending.catch(() => this.pending.delete(key));
    }
    return pending;
  }

  private async doInstall(key: string, manifest: object, lock: string | null, log: (line: string) => void): Promise<InstallInfo> {
    const dir = join(this.root, key);
    const done = join(dir, '.sandburg-complete');
    const exists = await access(done).then(() => true, () => false);
    if (!exists) {
      const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(tmp, { recursive: true });
      await writeFile(join(tmp, 'package.json'), JSON.stringify(manifest, null, 2));
      if (lock) await writeFile(join(tmp, 'package-lock.json'), lock);
      const base = await this.startFromClosest(manifest as Manifest, tmp, lock !== null);
      if (base) log(`starting from install ${base.key}, which has ${base.shared} of the same dependencies (npm installs the difference)`);
      // --omit=optional drops native builds such as @next/swc-*; the runtime uses their wasm builds.
      await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error'], tmp, log);
      await placeNextSwcWasm(tmp);
      await placeWasiBindings(tmp, log);
      await placeWasmBuilds(tmp, log);
      await writeBinIndex(tmp);
      await writeFile(join(tmp, '.sandburg-complete'), `${new Date().toISOString()} layout ${LAYOUT_VERSION}\n`);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
    }
    const resolved: Record<string, string> = {};
    for (const name of Object.keys((manifest as { dependencies: object }).dependencies)) {
      try {
        resolved[name] = (JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;
      } catch {
        // not installed (e.g. optional); the runtime reports it on require
      }
    }
    return { key, dir, resolved, lockfile: lock !== null, fromCache: exists };
  }

  /**
   * Starts a new install from the finished install that shares most of its dependencies: its
   * node_modules, hard-linked (instant), and its lockfile, so npm only installs the difference
   * (~0.5 s instead of ~7 s for a Next.js app). As with the install cache itself, versions that
   * installs share stay the ones npm picked for the first. Linux only (cp -al); elsewhere npm installs
   * everything. Files that installs change later are replaced, never written through the links.
   */
  private async startFromClosest(manifest: Manifest, tmp: string, hasLock: boolean): Promise<{ key: string; shared: number } | null> {
    if (process.platform !== 'linux') return null;
    const wanted = { ...manifest.dependencies, ...manifest.devDependencies };
    const names = Object.keys(wanted);
    if (!names.length) return null;
    let best: { key: string; shared: number; time: number } | null = null;
    for (const key of await readdir(this.root).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{24}$/.test(key)) continue;
      const done = await readFile(join(this.root, key, '.sandburg-complete'), 'utf8').catch(() => '');
      if (!done.includes(`layout ${LAYOUT_VERSION}`)) continue;
      let other: Manifest;
      try {
        other = JSON.parse(await readFile(join(this.root, key, 'package.json'), 'utf8')) as Manifest;
      } catch {
        continue;
      }
      if (JSON.stringify(other.overrides ?? null) !== JSON.stringify(manifest.overrides ?? null)) continue;
      const theirs = { ...other.dependencies, ...other.devDependencies };
      const shared = names.filter((n) => theirs[n] === wanted[n]).length;
      const time = Date.parse(done.split(' ')[0]) || 0;
      if (shared * 2 >= names.length && (!best || shared > best.shared || (shared === best.shared && time > best.time))) best = { key, shared, time };
    }
    if (!best) return null;
    const from = join(this.root, best.key);
    try {
      await run('cp', ['-al', join(from, 'node_modules'), join(tmp, 'node_modules')], tmp, () => {});
      // npm's record of the tree it installed describes the other install: it reads the tree instead.
      await rm(join(tmp, 'node_modules', '.package-lock.json'), { force: true });
      if (!hasLock) await cp(join(from, 'package-lock.json'), join(tmp, 'package-lock.json')).catch(() => {});
    } catch {
      await rm(join(tmp, 'node_modules'), { recursive: true, force: true });
      return null;
    }
    return { key: best.key, shared: best.shared };
  }

  /**
   * Several installs seen as one project tree (a root package and client/, server/ packages): a key
   * whose index holds each install's files under its directory ("server/node_modules/express/…").
   */
  combine(parts: { dir: string; key: string }[]): string {
    const key = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
    this.combined.set(key, parts);
    return key;
  }

  /** The install and path within it that a (possibly combined) key's path refers to. */
  private locate(key: string, rel: string): { key: string; rel: string } | null {
    const parts = this.combined.get(key);
    if (!parts) return { key, rel };
    for (const { dir, key: k } of parts) {
      if (!dir) {
        if (rel.startsWith('node_modules/')) return { key: k, rel };
      } else if (rel.startsWith(`${dir}/node_modules/`)) return { key: k, rel: rel.slice(dir.length + 1) };
    }
    return null;
  }

  /** All files under node_modules (paths relative to the install dir, e.g. "node_modules/next/package.json"). */
  index(key: string): Promise<FileIndex> {
    const parts = this.combined.get(key);
    if (parts) {
      return Promise.all(parts.map(async ({ dir, key: k }) => Object.entries(await this.index(k)).map(([rel, size]) => [dir ? `${dir}/${rel}` : rel, size] as const))).then(
        (lists) => Object.fromEntries(lists.flat()),
      );
    }
    let idx = this.indexes.get(key);
    if (!idx) {
      idx = buildIndex(join(this.root, key));
      this.indexes.set(key, idx);
    }
    return idx;
  }

  /** A file's original bytes (what fs.readFileSync sees). */
  async raw(combinedKey: string, combinedRel: string): Promise<{ body: Buffer; type: string } | null> {
    const at = this.locate(combinedKey, combinedRel);
    if (!at) return null;
    const { key, rel } = at;
    if (!/^[0-9a-f]{24}$/.test(key) || rel.split('/').includes('..') || !rel.startsWith('node_modules/')) return null;
    const index = await this.index(key);
    if (!(rel in index)) return null;
    return { body: await readFile(join(this.root, key, rel)), type: 'application/octet-stream' };
  }

  /** A file for the browser: JavaScript is compiled for the runtime (and cached); everything else is raw. */
  async file(combinedKey: string, combinedRel: string): Promise<{ body: Buffer; type: string } | null> {
    const at = this.locate(combinedKey, combinedRel);
    if (!at) return null;
    const { key, rel } = at;
    if (!/^[0-9a-f]{24}$/.test(key) || rel.split('/').includes('..') || !rel.startsWith('node_modules/')) return null;
    const index = await this.index(key);
    if (!(rel in index)) return null;
    const abs = join(this.root, key, rel);
    if (!/\.(c|m)?js$/.test(rel)) return { body: await readFile(abs), type: 'application/octet-stream' };
    // Transforms are kept by content, not by install: every install with the same package version
    // shares them (a new app with next@15 does not transform Next.js again).
    const source = await readFile(abs, 'utf8');
    const esm = rel.endsWith('.mjs') || (!rel.endsWith('.cjs') && (await packageType(join(this.root, key), rel)) === 'module');
    const hash = createHash('sha256').update(`${esm ? 'esm' : 'cjs'}\0${rel}\0`).update(source).digest('hex');
    const cached = join(this.root, '..', 'transforms', `v${TRANSFORM_VERSION}`, hash.slice(0, 2), `${hash.slice(2)}.js`);
    try {
      return { body: await readFile(cached), type: 'text/javascript' };
    } catch {
      // not transformed yet
    }
    const body = Buffer.from(await transformForRuntime(source, rel, esm));
    await mkdir(join(cached, '..'), { recursive: true });
    const tmp = `${cached}.${tmpSuffix()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, cached);
    return { body, type: 'text/javascript' };
  }
}

/**
 * Compiles a module for the browser runtime. ESM becomes CommonJS (the loader
 * is CommonJS, like Node's require()); async functions and generators are
 * lowered to generator-based code, whose awaits go through Promise.then, which
 * the runtime patches to carry AsyncLocalStorage context.
 */
export async function transformForRuntime(source: string, path: string, esm: boolean): Promise<string> {
  for (const patch of SOURCE_PATCHES) if (patch.file.test(path)) source = source.replace(patch.from, patch.to);
  if (esm) source = renameCommonJsNames(source.replace(/^#!.*/, ''));
  source = patchFunctionImport(patchAsyncFunction(source));
  // Code from an ES module is marked: the loader resolves its requests with import conditions.
  const mark = (code: string) => patchInterop(esm ? `/*sandburg:esm*/\n${code}` : code);
  try {
    const out = await esbuild.transform(source, TRANSFORM_OPTIONS(path, esm));
    return mark(out.code);
  } catch {
    // Top-level await (e.g. vite/bin/vite.js): an async module (see tla.ts).
    if (esm && hasTopLevelAwait(source.replace(/^#!.*/, ''))) {
      try {
        return mark((await esbuild.transform(toAsyncModule(source.replace(/^#!.*/, '')), TRANSFORM_OPTIONS(path, true))).code);
      } catch {
        // fall through
      }
    }
    // Syntax esbuild cannot lower (rare): run it as is; AsyncLocalStorage may lose context there.
    return source;
  }
}

export const TRANSFORM_OPTIONS = (path: string, esm: boolean): esbuild.TransformOptions => ({
  loader: 'js',
  format: esm ? 'cjs' : undefined,
  sourcefile: esm ? esmSourcefile(path) : path,
  target: 'es2022',
  // import() goes through the runtime's loader (require), like everything else.
  supported: { 'async-await': false, 'async-generator': false, 'for-await': false, 'dynamic-import': false },
  define: esm ? { 'import.meta.url': '__sandburg_import_meta_url', 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' } : undefined,
  logLevel: 'silent',
});

const typeCache = new Map<string, 'module' | 'commonjs'>();

/** "type" of the nearest package.json, as Node decides a .js file's format. */
async function packageType(installDir: string, rel: string): Promise<'module' | 'commonjs'> {
  const parts = rel.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const pj = join(installDir, ...parts.slice(0, i), 'package.json');
    const hit = typeCache.get(pj);
    if (hit) return hit;
    try {
      const type = (JSON.parse(await readFile(pj, 'utf8')) as { type?: string }).type === 'module' ? 'module' : 'commonjs';
      typeCache.set(pj, type);
      return type;
    } catch {
      // keep walking up
    }
  }
  return 'commonjs';
}

/**
 * Next.js looks for its SWC WebAssembly build in next/wasm/@next/swc-wasm-nodejs
 * (where its own on-demand download would extract it). Put the installed copy there.
 */
/**
 * napi-rs packages (rolldown, the Astro compiler, oxc, …) list a `*-wasm32-wasi` build among their
 * optional dependencies; npm skips it on this platform (cpu: wasm32). The runtime loads those builds
 * through node:wasi, so they are installed here, with their own dependencies (@napi-rs/wasm-runtime,
 * @emnapi/*), next to the native-only packages npm chose.
 */
async function placeWasiBindings(dir: string, log: (line: string) => void): Promise<void> {
  const nm = join(dir, 'node_modules');
  const wanted: Record<string, string> = {};
  const candidates: Record<string, string> = {};
  const visit = async (pkgDir: string) => {
    try {
      const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> };
      for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) {
        if (/wasm32-wasi$/.test(name)) wanted[name] = range;
        // napi-rs platform packages (<name>-linux-x64-gnu): the WebAssembly build is <name>-wasm32-wasi, if published.
        else if (/-linux-x64-gnu$/.test(name)) candidates[name.replace(/-linux-x64-gnu$/, '-wasm32-wasi')] = range;
      }
    } catch {
      // not a package
    }
  };
  for (const entry of await readdir(nm, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const sub of await readdir(join(nm, entry.name), { withFileTypes: true })) if (sub.isDirectory()) await visit(join(nm, entry.name, sub.name));
    } else await visit(join(nm, entry.name));
  }
  const checks = await Promise.all(
    Object.entries(candidates)
      .filter(([name]) => !(name in wanted))
      .map(async ([name, range]) => ((await npmViewVersion(`${name}@${range}`)) ? ([name, range] as const) : null)),
  );
  for (const hit of checks) if (hit) wanted[hit[0]] = hit[1];
  const missing = Object.entries(wanted).filter(([name]) => !existsSyncSafe(join(nm, name, 'package.json')));
  if (!missing.length) return;
  const side = join(dir, '.sandburg-wasi');
  await mkdir(side, { recursive: true });
  await writeFile(join(side, 'package.json'), JSON.stringify({ name: 'sandburg-wasi', private: true, dependencies: Object.fromEntries(missing) }));
  // --force: these packages declare cpu "wasm32"; nothing is run (--ignore-scripts).
  await run('npm', ['install', '--force', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], side, log);
  // Each binding goes to the top level with its dependencies (napi-rs's wasm runtime, emnapi) nested
  // inside it, so versions the project already has elsewhere cannot shadow the ones it was built with.
  const sideNm = join(side, 'node_modules');
  const sidePackages: string[] = [];
  for (const entry of await readdir(sideNm, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) for (const sub of await readdir(join(sideNm, entry.name))) sidePackages.push(`${entry.name}/${sub}`);
    else sidePackages.push(entry.name);
  }
  for (const [binding] of missing) {
    if (!existsSyncSafe(join(sideNm, binding, 'package.json'))) continue;
    await rm(join(nm, binding), { recursive: true, force: true });
    await cp(join(sideNm, binding), join(nm, binding), { recursive: true });
    for (const dep of sidePackages) {
      if (dep in wanted) continue;
      const to = join(nm, binding, 'node_modules', dep);
      if (!existsSyncSafe(join(to, 'package.json'))) await cp(join(sideNm, dep), to, { recursive: true });
    }
  }
  await rm(side, { recursive: true, force: true });
  log(`added WebAssembly builds: ${missing.map(([n]) => n).join(', ')}`);
}

/** Whether a package version exists on the registry (npm view). */
function npmViewVersion(spec: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['view', spec, 'version', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

function existsSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Packages whose native code has a WebAssembly build of the same version with the same API. Each
 * installed copy gets that build installed next to it (in its own node_modules), and the file that
 * loads the native code is replaced by one that loads the WebAssembly build.
 */
const WASM_BUILDS: { name: string; wasm: string; file: string; applies(version: string): boolean; shim: string; also?: Record<string, string> }[] = [
  {
    // The Dart Sass compiler as a native program (sass-embedded-<platform>, which it runs over a pipe):
    // the same compiler compiled to JavaScript (sass), with the same API. Angular's CLI and Vite
    // prefer sass-embedded when it is installed.
    name: 'sass-embedded',
    wasm: 'sass',
    file: 'dist/lib/index.js',
    applies: (v) => /^1\./.test(v),
    shim: "// sandburg: Dart Sass compiled to JavaScript (sass) in place of the native embedded compiler\nmodule.exports = require('../../node_modules/sass/sass.node.js');\n",
    also: {
      'dist/lib/index.mjs': "// sandburg: Dart Sass compiled to JavaScript (sass) in place of the native embedded compiler\nexport * from '../../node_modules/sass/sass.node.mjs';\nexport { default } from '../../node_modules/sass/sass.node.mjs';\n",
    },
  },
  {
    // Rollup 4's parser (@rollup/rollup-<platform>).
    name: 'rollup',
    wasm: '@rollup/wasm-node',
    file: 'dist/native.js',
    applies: (v) => /^4\./.test(v),
    shim: "// sandburg: rollup's WebAssembly build (@rollup/wasm-node)\nmodule.exports = require('../node_modules/@rollup/wasm-node/dist/native.js');\n",
  },
  {
    // lightningcss's native parser (lightningcss-<platform>): Tailwind CSS v4, Vite's CSS minifier.
    name: 'lightningcss',
    wasm: 'lightningcss-wasm',
    file: 'node/index.js',
    applies: (v) => /^1\./.test(v),
    shim: "// sandburg: lightningcss's WebAssembly build (lightningcss-wasm), loaded synchronously\nmodule.exports = require('../node_modules/lightningcss-wasm/wasm-node.cjs');\n",
  },
  {
    // esbuild's Go binary (@esbuild/<platform>): its browser build, which runs the compiler in this thread.
    name: 'esbuild',
    wasm: 'esbuild-wasm',
    file: 'lib/main.js',
    applies: (v) => /^0\.(1[89]|[2-9]\d)\./.test(v),
    shim: `// sandburg: esbuild's WebAssembly build (esbuild-wasm). The synchronous API needs a separate thread and is unavailable.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../node_modules/esbuild-wasm');
// Its in-thread service reads the worker global \`self\`, which the runtime leaves undefined (as in Node).
// Go's file system calls go to that scope's \`fs\`: the runtime's, as esbuild-wasm has under Node.
// The service sets read (stdin) and writeSync (stdout, stderr) on it for its pipes: those take the
// pipes' descriptors, the file system keeps the rest. Go writes with fs.write, which goes to writeSync
// for the pipes (as in esbuild-wasm's own stub fs).
const scopeFs = Object.create(fs);
const pipes = { read: null, writeSync: null };
Object.defineProperty(scopeFs, 'read', {
  get: () => (fd, ...rest) => (fd === 0 && pipes.read ? pipes.read(fd, ...rest) : fs.read(fd, ...rest)),
  set: (fn) => (pipes.read = fn),
});
Object.defineProperty(scopeFs, 'writeSync', {
  get: () => (fd, buf, ...rest) => ((fd === 1 || fd === 2) && pipes.writeSync ? pipes.writeSync(fd, buf) : fs.writeSync(fd, buf, ...rest)),
  set: (fn) => (pipes.writeSync = fn),
});
scopeFs.write = (fd, buf, offset, length, position, callback) => {
  if ((fd !== 1 && fd !== 2) || !pipes.writeSync) return fs.write(fd, buf, offset, length, position, callback);
  try {
    callback(null, pipes.writeSync(fd, offset === 0 && length === buf.length ? buf : buf.subarray(offset, offset + length)));
  } catch (e) {
    callback(e);
  }
};
// Other globals are read from the real global object (its getters, e.g. location, need it as receiver).
const scope = new Proxy(Object.create(globalThis, { fs: { value: scopeFs, enumerable: true } }), {
  get: (target, key) => (key === 'fs' ? scopeFs : Reflect.get(globalThis, key)),
});
const browser = { exports: {} };
new Function('self', 'module', 'exports', 'require', fs.readFileSync(path.join(dir, 'lib/browser.js'), 'utf8'))(scope, browser, browser.exports, require);
const esbuild = browser.exports;
let ready;
const init = () =>
  (ready ??= esbuild.initialize({ wasmModule: new WebAssembly.Module(fs.readFileSync(path.join(dir, 'esbuild.wasm'))), worker: false }));
const later = (name) => (...args) => init().then(() => esbuild[name](...args));
// The browser build has no file system of its own, so no \`write: true\` (the default under Node): it
// builds in memory and the output is written here, as esbuild does under Node.
const writeOutput = (result, write) => {
  if (!write || !result || !result.outputFiles) return result;
  for (const file of result.outputFiles) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.contents);
  }
  const { outputFiles, ...rest } = result;
  return rest;
};
const inMemory = (options) => ({ ...options, write: false });
const build = (options = {}) => init().then(() => esbuild.build(inMemory(options))).then((r) => writeOutput(r, options.write !== false));
const context = (options = {}) =>
  init().then(() => esbuild.context(inMemory(options))).then((ctx) => ({
    ...ctx,
    rebuild: () => ctx.rebuild().then((r) => writeOutput(r, options.write !== false)),
    watch: ctx.watch,
    serve: ctx.serve,
    cancel: ctx.cancel,
    dispose: ctx.dispose,
  }));
const sync = (name) => () => {
  throw new Error('esbuild.' + name + '() is not available in the browser runtime (esbuild-wasm has no synchronous API there); use the asynchronous API');
};
module.exports = {
  version: esbuild.version,
  build,
  context,
  transform: later('transform'),
  formatMessages: later('formatMessages'),
  analyzeMetafile: later('analyzeMetafile'),
  buildSync: sync('buildSync'),
  transformSync: sync('transformSync'),
  formatMessagesSync: sync('formatMessagesSync'),
  analyzeMetafileSync: sync('analyzeMetafileSync'),
  initialize: () => init().then(() => undefined),
  stop: () => Promise.resolve(),
};
`,
  },
];

async function placeWasmBuilds(dir: string, log: (line: string) => void): Promise<void> {
  const found: { dir: string; version: string; build: (typeof WASM_BUILDS)[number] }[] = [];
  const walk = async (nm: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(nm, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const pkgDirs = e.name.startsWith('@') ? (await readdir(join(nm, e.name))).map((sub) => join(nm, e.name, sub)) : [join(nm, e.name)];
      for (const pkgDir of pkgDirs) {
        const build = WASM_BUILDS.find((b) => pkgDir.endsWith(`${sep}${b.name.split('/').join(sep)}`) && existsSyncSafe(join(pkgDir, b.file)));
        if (build) {
          const version = (JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
          if (build.applies(version)) found.push({ dir: pkgDir, version, build });
        }
        if (depth < 4) await walk(join(pkgDir, 'node_modules'), depth + 1);
      }
    }
  };
  await walk(join(dir, 'node_modules'), 0);
  for (const { dir: pkgDir, version, build } of found) {
    const target = join(pkgDir, 'node_modules', build.wasm);
    if (!existsSyncSafe(join(target, 'package.json'))) {
      const side = join(dir, '.sandburg-wasm-build');
      await rm(side, { recursive: true, force: true });
      await mkdir(side, { recursive: true });
      await writeFile(join(side, 'package.json'), JSON.stringify({ name: 'sandburg-wasm-build', private: true, dependencies: { [build.wasm]: version } }));
      await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], side, log);
      await cp(join(side, 'node_modules', build.wasm), target, { recursive: true });
      // Its own dependencies (lightningcss-wasm's napi-wasm) go inside it.
      const sideNm = join(side, 'node_modules');
      for (const entry of await readdir(sideNm, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const names = entry.name.startsWith('@') ? (await readdir(join(sideNm, entry.name))).map((n) => `${entry.name}/${n}`) : [entry.name];
        for (const dep of names) if (dep !== build.wasm) await cp(join(sideNm, dep), join(target, 'node_modules', dep), { recursive: true });
      }
      await rm(side, { recursive: true, force: true });
    }
    await replaceFile(join(pkgDir, build.file), build.shim);
    for (const [file, shim] of Object.entries(build.also ?? {})) await replaceFile(join(pkgDir, file), shim);
    log(`${build.name} ${version}: using ${build.wasm}`);
  }
}

/**
 * Changes to package sources for what the browser cannot do. piscina's workers wait for tasks with
 * Atomics.wait and take them with receiveMessageOnPort, which needs a synchronous look into a
 * MessagePort (browsers have none): they use its message-event mode instead, as under WebContainers.
 */
const SOURCE_PATCHES: { file: RegExp; from: string | RegExp; to: string }[] = [
  {
    file: /(^|\/)node_modules\/piscina\/dist\/(esm-)?worker\.m?js$/,
    from: /useAtomics = useAtomics !== false && message\.atomics !== 'disabled';/,
    to: "useAtomics = false; // sandburg: no receiveMessageOnPort in the browser runtime",
  },
  {
    // piscina 4
    file: /(^|\/)node_modules\/piscina\/dist\/src\/worker\.js$|(^|\/)node_modules\/piscina\/dist\/worker\.js$/,
    from: /useAtomics = process\.env\.PISCINA_DISABLE_ATOMICS === '1' \? false : message\.useAtomics;/,
    to: "useAtomics = false; // sandburg: no receiveMessageOnPort in the browser runtime",
  },
];

/**
 * Writes a file as a new file: an install may share files with another through hard links (see
 * Installer.startFromClosest), and writing into one would change both.
 */
async function replaceFile(path: string, content: string | Buffer): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, content);
}

/**
 * node_modules/.sandburg-bins.json: each package binary (node_modules/.bin/<name>) and the script it
 * runs, relative to the install directory. The runtime's shell resolves commands with it.
 */
async function writeBinIndex(dir: string): Promise<void> {
  const binDir = join(dir, 'node_modules', '.bin');
  const bins: Record<string, string> = {};
  for (const name of await readdir(binDir).catch(() => [] as string[])) {
    try {
      const target = await readlink(join(binDir, name));
      bins[name] = relative(dir, resolve(binDir, target)).split(sep).join('/');
    } catch {
      // not a link (npm links every binary)
    }
  }
  await replaceFile(join(dir, 'node_modules', '.sandburg-bins.json'), JSON.stringify(bins));
}

async function placeNextSwcWasm(dir: string): Promise<void> {
  const from = join(dir, 'node_modules', '@next', 'swc-wasm-nodejs');
  const next = join(dir, 'node_modules', 'next');
  if (!(await access(from).then(() => true, () => false)) || !(await access(next).then(() => true, () => false))) return;
  const to = join(next, 'wasm', '@next', 'swc-wasm-nodejs');
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}

async function buildIndex(dir: string): Promise<FileIndex> {
  const index: FileIndex = {};
  async function walk(abs: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.cache' || entry.name === '.sandburg-transformed') continue;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) index[relative(dir, full).split(sep).join('/')] = (await lstat(full)).size;
      // npm does not create symlinks without workspaces; others are skipped
    }
  }
  await walk(join(dir, 'node_modules'));
  return index;
}

function run(cmd: string, args: string[], cwd: string, log: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_update_notifier: 'false' } });
    let out = '';
    const onData = (b: Buffer) => {
      out += b.toString();
      for (const line of b.toString().split('\n')) if (line.trim()) log(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} failed (exit ${code}): ${out.trim().split('\n').slice(-10).join('\n')}`))));
  });
}
