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
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import { hasTopLevelAwait, toAsyncModule } from './tla.ts';
import { renameCommonJsNames } from './esm-names.ts';
import { patchAsyncFunction, patchInterop } from './interop.ts';
import type { Project } from '../../types.ts';

/** Bump when the transform changes, so cached transforms are rebuilt. */
const TRANSFORM_VERSION = 6;
/** Bump when what an install contains changes (e.g. WebAssembly bindings added), so installs are redone. */
const LAYOUT_VERSION = 4;

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

export class Installer {
  readonly root: string;
  private pending = new Map<string, Promise<InstallInfo>>();
  private indexes = new Map<string, Promise<FileIndex>>();

  constructor(root: string) {
    this.root = root;
  }

  /** Installs `project`'s dependencies plus `extra` (name → spec) unless already cached. */
  install(project: Project, extra: Record<string, string>, log: (line: string) => void): Promise<InstallInfo> {
    const pkg = project.packageJson ?? {};
    const lock = project.files['package-lock.json'];
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
      .update(typeof lock === 'string' ? lock : '')
      .digest('hex')
      .slice(0, 24);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.doInstall(key, manifest, typeof lock === 'string' ? lock : null, log);
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
      // --omit=optional drops native builds such as @next/swc-*; the runtime uses their wasm builds.
      await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error'], tmp, log);
      await placeNextSwcWasm(tmp);
      await placeWasiBindings(tmp, log);
      await writeFile(join(tmp, '.sandburg-complete'), new Date().toISOString());
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

  /** All files under node_modules (paths relative to the install dir, e.g. "node_modules/next/package.json"). */
  index(key: string): Promise<FileIndex> {
    let idx = this.indexes.get(key);
    if (!idx) {
      idx = buildIndex(join(this.root, key));
      this.indexes.set(key, idx);
    }
    return idx;
  }

  /** A file's original bytes (what fs.readFileSync sees). */
  async raw(key: string, rel: string): Promise<{ body: Buffer; type: string } | null> {
    if (!/^[0-9a-f]{24}$/.test(key) || rel.split('/').includes('..') || !rel.startsWith('node_modules/')) return null;
    const index = await this.index(key);
    if (!(rel in index)) return null;
    return { body: await readFile(join(this.root, key, rel)), type: 'application/octet-stream' };
  }

  /** A file for the browser: JavaScript is compiled for the runtime (and cached); everything else is raw. */
  async file(key: string, rel: string): Promise<{ body: Buffer; type: string } | null> {
    if (!/^[0-9a-f]{24}$/.test(key) || rel.split('/').includes('..') || !rel.startsWith('node_modules/')) return null;
    const index = await this.index(key);
    if (!(rel in index)) return null;
    const abs = join(this.root, key, rel);
    if (!/\.(c|m)?js$/.test(rel)) return { body: await readFile(abs), type: 'application/octet-stream' };
    const cached = join(this.root, key, '.sandburg-transformed', `v${TRANSFORM_VERSION}`, rel);
    try {
      return { body: await readFile(cached), type: 'text/javascript' };
    } catch {
      // not transformed yet
    }
    const source = await readFile(abs, 'utf8');
    const esm = rel.endsWith('.mjs') || (!rel.endsWith('.cjs') && (await packageType(join(this.root, key), rel)) === 'module');
    const body = Buffer.from(await transformForRuntime(source, rel, esm));
    await mkdir(join(cached, '..'), { recursive: true });
    await writeFile(cached, body);
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
  if (esm) source = renameCommonJsNames(source.replace(/^#!.*/, ''));
  source = patchAsyncFunction(source);
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
  sourcefile: path,
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

async function placeNextSwcWasm(dir: string): Promise<void> {
  const from = join(dir, 'node_modules', '@next', 'swc-wasm-nodejs');
  const next = join(dir, 'node_modules', 'next');
  if (!(await access(from).then(() => true, () => false)) || !(await access(next).then(() => true, () => false))) return;
  await cp(from, join(next, 'wasm', '@next', 'swc-wasm-nodejs'), { recursive: true });
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
