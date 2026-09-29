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
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import type { Project } from '../../types.ts';

/** Bump when the transform changes, so cached transforms are rebuilt. */
const TRANSFORM_VERSION = 2;

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
  try {
    const out = await esbuild.transform(source, TRANSFORM_OPTIONS(path, esm));
    return out.code;
  } catch {
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
