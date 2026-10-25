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
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { access, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import { hasTopLevelAwait, toAsyncModule } from './tla.ts';
import { collidesWithWrapper, ESM_DEFINE, renameCommonJsNames } from './esm-names.ts';
import { esmSourcefile, patchAsyncFunction, patchFunctionImport, patchInterop } from './interop.ts';
import type { Project } from '../../types.ts';
import { NEXT_SWC_WASM, SOURCE_PATCHES, WASM_BUILDS, wasiBindings } from './install-rules.ts';
import { Resolver } from './resolver.ts';
import { installFromLockfile, installedPackages, linkTree, sweepStore, unpackAhead, unpackHint, type InstalledPackage } from './package-store.ts';

/** --omit=optional drops native builds such as @next/swc-*; the runtime uses their wasm builds. */
const INSTALL_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--loglevel=error'];

/** Bump when the transform changes, so cached transforms are rebuilt. */
export const TRANSFORM_VERSION = 14;
/** Bump when what an install contains changes (e.g. WebAssembly bindings added), so installs are redone. */
const LAYOUT_VERSION = 16;

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
  /** Transforms in progress, by content hash. */
  private transforming = new Map<string, Promise<Buffer>>();

  /** Unpacked packages, by integrity, that installs hard-link (package-store.ts). */
  private readonly store: string;
  /** npm's resolution, in a worker that keeps packuments between installs (resolver.ts). */
  private readonly resolver: Resolver;
  /** Where WebAssembly side installs are kept, and how they are made. */
  private readonly sides: Sides;

  constructor(root: string) {
    this.root = root;
    this.store = join(root, '..', 'store');
    this.resolver = new Resolver(root, ['--package-lock-only', ...INSTALL_FLAGS]);
    this.sides = { root: join(root, '..', 'side-installs'), store: this.store, resolver: this.resolver };
    // As npm's resolution picks each package: it is unpacked, and what wasiBindingsFor and
    // wasmBuildsFor will ask about it (whether its napi-rs bindings have a WASI build, the
    // WebAssembly build that replaces it) is under way. Guesses: npm may pick another version.
    this.resolver.onPicked = ({ name, version, integrity, optionalDependencies }) => {
      unpackHint(integrity, this.store);
      for (const [binding, range] of Object.entries(wasiBindings(optionalDependencies).candidates)) void npmViewVersion(`${binding}@${range}`, this.resolver);
      const build = WASM_BUILDS.find((b) => b.name === name && b.applies(version));
      if (build) wasmBuild(this.sides, build, version, () => {}).catch(() => {});
    };
    void this.sweep();
  }

  /** Loads npm in the resolver's worker (see Resolver.warm), so that a first install does not wait for it. */
  prepare(): void {
    this.resolver.warm();
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
    await sweepSideInstalls(join(this.root, '..', 'side-installs'));
    await sweepStore(this.store);
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
      if (base) log(`starting from install ${base.key}'s lockfile, which has ${base.shared} of the same dependencies`);
      // npm resolves the tree; the package store unpacks it (see package-store.ts), or npm does
      // when the lockfile has what the store does not handle.
      const flags = INSTALL_FLAGS;
      const m = manifest as Manifest;
      const ahead = unpackAhead(tmp, { ...m.devDependencies, ...m.dependencies }, this.store);
      if (!(await this.resolver.resolve(tmp, log))) await run('npm', ['install', '--package-lock-only', ...flags], tmp, log);
      // The WebAssembly bindings and builds the tree needs are installed (each in a directory of its
      // own, waiting on npm and the registry) while the tree is unpacked; they are put in place after.
      const packages = installedPackages(JSON.parse(await readFile(join(tmp, 'package-lock.json'), 'utf8').catch(() => '{}')));
      const sides = this.sides;
      const additions = Promise.all([wasiBindingsFor(tmp, sides, packages, log), wasmBuildsFor(tmp, sides, packages, log)]);
      additions.catch(() => {});
      if (!(await installFromLockfile(tmp, this.store, log))) await run('npm', ['install', ...flags], tmp, log);
      await ahead;
      // npm creates no node_modules for a project without dependencies; the steps below read it.
      await mkdir(join(tmp, 'node_modules'), { recursive: true });
      // They change different directories: the bindings are new top-level packages, the builds go
      // inside the packages they replace.
      const [placeBindings, placeBuilds] = await additions;
      await Promise.all([placeNextSwcWasm(tmp), placeBindings(), placeBuilds()]);
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
   * Starts a new install's resolution from the lockfile of the finished install that shares most of
   * its dependencies, so that npm only resolves the difference and, as with the install cache
   * itself, versions that installs share stay the ones npm picked for the first. The packages
   * themselves come from the package store.
   */
  private async startFromClosest(manifest: Manifest, tmp: string, hasLock: boolean): Promise<{ key: string; shared: number } | null> {
    if (hasLock) return null;
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
    try {
      await cp(join(this.root, best.key, 'package-lock.json'), join(tmp, 'package-lock.json'));
    } catch {
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
    // Small files synchronously, as in file(); large ones (WebAssembly binaries) without blocking.
    const abs = join(this.root, key, rel);
    return { body: index[rel] <= SYNC_READ_MAX ? readFileSync(abs) : await readFile(abs), type: 'application/octet-stream' };
  }

  /**
   * A small file's original bytes, read synchronously (a few hundred of them for a read-ahead
   * answer: ~10 ms, where awaiting each read took ~60 ms), or null; only for paths in `index`, the
   * install's (as `raw` checks).
   */
  rawSync(combinedKey: string, combinedRel: string, index: FileIndex): Buffer | null {
    if (!(combinedRel in index)) return null;
    const at = this.locate(combinedKey, combinedRel);
    if (!at) return null;
    const { key, rel } = at;
    if (!/^[0-9a-f]{24}$/.test(key) || rel.split('/').includes('..') || !rel.startsWith('node_modules/')) return null;
    try {
      return readFileSync(join(this.root, key, rel));
    } catch {
      return null;
    }
  }

  /** A file for the browser: JavaScript is compiled for the runtime (and cached); everything else is raw. */
  async file(combinedKey: string, combinedRel: string): Promise<{ body: Buffer; type: string } | null> {
    const at = this.locate(combinedKey, combinedRel);
    if (!at) return null;
    const { key, rel } = at;
    if (!/^[0-9a-f]{24}$/.test(key) || rel.split('/').includes('..') || !rel.startsWith('node_modules/')) return null;
    const remembered = this.remember(`${key}\0${rel}`);
    if (remembered) return { body: remembered, type: 'text/javascript' };
    const index = await this.index(key);
    if (!(rel in index)) return null;
    const abs = join(this.root, key, rel);
    // A module without an extension (a bin script such as TypeScript 7's bin/tsc) is JavaScript, as
    // Node loads it: ESM in a "type": "module" package.
    if (!/\.(c|m)?js$/.test(rel) && /\.[^/.]+$/.test(rel)) return { body: await readFile(abs), type: 'application/octet-stream' };
    // Transforms are kept by content, not by install: every install with the same package version
    // shares them (a new app with next@16 does not transform Next.js again).
    // Read synchronously, as the transform's cache entry below: installed files and transforms are
    // small and just written (in the page cache), and a promise-based read (open, stat, read, close)
    // cost the host's main thread ~0.15 ms each, ~0.4 s of a cold Astro start.
    const source = readFileSync(abs, 'utf8');
    const esm = rel.endsWith('.mjs') || (!rel.endsWith('.cjs') && (await packageType(join(this.root, key), rel, index)) === 'module');
    const hash = createHash('sha256').update(`${esm ? 'esm' : 'cjs'}\0${rel}\0`).update(source).digest('hex');
    const cached = join(this.root, '..', 'transforms', `v${TRANSFORM_VERSION}`, hash.slice(0, 2), `${hash.slice(2)}.js`);
    // A transform in progress (the prefetcher's, see prefetch.ts, or another runtime's) is waited for.
    let pending = this.transforming.get(hash);
    if (!pending) {
      try {
        return { body: this.remember(`${key}\0${rel}`, readFileSync(cached))!, type: 'text/javascript' };
      } catch {
        // not transformed yet
      }
      pending = (async () => Buffer.from(await transformForRuntime(source, rel, esm)))();
      this.transforming.set(hash, pending);
      // Answered once transformed; it stays in progress (for other requests) until it is on disk.
      void pending
        .then((body) => this.persist(cached, body))
        .catch(() => {})
        .finally(() => this.transforming.delete(hash));
    }
    return { body: this.remember(`${key}\0${rel}`, await pending)!, type: 'text/javascript' };
  }

  /** A transform of an install's file this process has in memory (see remember), or undefined. */
  remembered(key: string, rel: string): Buffer | undefined {
    return this.combined.has(key) ? undefined : this.memory.get(`${key}\0${rel}`);
  }

  /** Transform cache directories made by this process. */
  private made = new Set<string>();

  private async persist(file: string, body: Buffer): Promise<void> {
    const dir = join(file, '..');
    if (!this.made.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.made.add(dir);
    }
    const tmp = `${file}.${tmpSuffix()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  }

  /**
   * Transformed files served lately, by install and path (an install does not change once made). A
   * hit skips reading the file, hashing it and reading its transform: 0.02 ms instead of 1.2 ms, and
   * ~5 ms while the host is busy, for each of the ~1,300 requests of a next dev that starts without
   * a preload bundle.
   */
  private memory = new Map<string, Buffer>();
  private memoryBytes = 0;

  /** The remembered transform of `id` (or remembers `body`), least recently used out first. */
  private remember(id: string, body?: Buffer): Buffer | undefined {
    const known = this.memory.get(id);
    if (known) {
      this.memory.delete(id);
      this.memory.set(id, known);
      return known;
    }
    if (!body) return undefined;
    this.memory.set(id, body);
    this.memoryBytes += body.length;
    for (const [old, b] of this.memory) {
      if (this.memoryBytes <= MEMORY_MAX) break;
      this.memory.delete(old);
      this.memoryBytes -= b.length;
    }
    return body;
  }
}

/** Installed files up to this size are read synchronously (see Installer.file). */
const SYNC_READ_MAX = 1 << 20;

/** Bytes of transforms kept in memory (Installer.remember). */
const MEMORY_MAX = 256 << 20;

/**
 * Compiles a module for the browser runtime. ESM becomes CommonJS (the loader
 * is CommonJS, like Node's require()); async functions and generators are
 * lowered to generator-based code, whose awaits go through Promise.then, which
 * the runtime patches to carry AsyncLocalStorage context.
 */
export async function transformForRuntime(source: string, path: string, esm: boolean): Promise<string> {
  for (const patch of SOURCE_PATCHES) if (patch.file.test(path)) source = source.replace(patch.from, patch.to);
  if (esm) source = source.replace(/^#!.*/, '');
  source = patchFunctionImport(patchAsyncFunction(source));
  // Code from an ES module is marked: the loader resolves its requests with import conditions.
  const mark = (code: string) => patchInterop(esm ? `/*sandburg:esm*/\n${code}` : code);
  // A declaration of a CommonJS name that esbuild does not rename (see esm-names.ts): renamed first.
  const convert = async (code: string) => {
    const out = (await esbuild.transform(code, TRANSFORM_OPTIONS(path, esm))).code;
    return esm && collidesWithWrapper(out) ? (await esbuild.transform(renameCommonJsNames(code), TRANSFORM_OPTIONS(path, esm))).code : out;
  };
  try {
    return mark(await convert(source));
  } catch {
    // Top-level await (e.g. vite/bin/vite.js): an async module (see tla.ts).
    if (esm && hasTopLevelAwait(source)) {
      try {
        return mark(await convert(toAsyncModule(source)));
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
  define: esm ? ESM_DEFINE : undefined,
  logLevel: 'silent',
});

/** By directory (absolute): the "type" of the nearest package.json, found or being found. */
const typeCache = new Map<string, Promise<'module' | 'commonjs'>>();

/**
 * "type" of the nearest package.json, as Node decides a .js file's format. Only the package.json
 * files the install's index has are read (looking for absent ones was ~0.5 s of the host's 5.5 s
 * in a cold next dev start), once per directory.
 */
function packageType(installDir: string, rel: string, index: FileIndex): Promise<'module' | 'commonjs'> {
  const dir = rel.slice(0, Math.max(rel.lastIndexOf('/'), 0));
  const id = `${installDir}\0${dir}`;
  let type = typeCache.get(id);
  if (!type) {
    type = (async () => {
      if (!dir) return 'commonjs';
      if (`${dir}/package.json` in index) {
        try {
          return (JSON.parse(await readFile(join(installDir, dir, 'package.json'), 'utf8')) as { type?: string }).type === 'module' ? 'module' : 'commonjs';
        } catch {
          // unreadable: keep walking up, as before
        }
      }
      return packageType(installDir, dir, index);
    })();
    typeCache.set(id, type);
  }
  return type;
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
async function wasiBindingsFor(dir: string, sides: Sides, packages: InstalledPackage[], log: (line: string) => void): Promise<() => Promise<void>> {
  const nm = join(dir, 'node_modules');
  const wanted: Record<string, string> = {};
  const candidates: Record<string, string> = {};
  const top = new Set<string>();
  for (const p of packages) {
    const name = p.location.slice('node_modules/'.length);
    if (!/^(@[^/]+\/)?[^/]+$/.test(name)) continue;
    top.add(name);
    const found = wasiBindings(p.optionalDependencies);
    Object.assign(wanted, found.listed);
    Object.assign(candidates, found.candidates);
  }
  // --force: these packages declare cpu "wasm32"; nothing is run (--ignore-scripts).
  const install = (bindings: [string, string][]) =>
    sideInstall(sides, { name: 'sandburg-wasi', private: true, dependencies: Object.fromEntries(bindings) }, ['--force', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], log);
  // The listed bindings are installed while npm view looks for the others. Most of those do not
  // exist; when one does, all are installed together, as one tree.
  const listed = Object.entries(wanted).filter(([name]) => !top.has(name));
  const early = listed.length ? install(listed) : null;
  early?.catch(() => {});
  const checks = await Promise.all(
    Object.entries(candidates)
      .filter(([name]) => !(name in wanted))
      .map(async ([name, range]) => ((await npmViewVersion(`${name}@${range}`, sides.resolver)) ? ([name, range] as const) : null)),
  );
  const hits = checks.filter((hit) => hit !== null);
  for (const hit of hits) wanted[hit[0]] = hit[1];
  const missing = Object.entries(wanted).filter(([name]) => !top.has(name));
  if (!missing.length) return async () => {};
  let side: string;
  if (early && !hits.length) side = await early;
  else side = await install(missing);
  return async () => {
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
      await place(join(sideNm, binding), join(nm, binding));
      for (const dep of sidePackages) {
        if (dep in wanted) continue;
        const to = join(nm, binding, 'node_modules', dep);
        if (!existsSyncSafe(join(to, 'package.json'))) await place(join(sideNm, dep), to);
      }
    }
    log(`added WebAssembly builds: ${missing.map(([n]) => n).join(', ')}`);
  };
}

/**
 * Side installs of another layout, and ones a process left unfinished (*.tmp-*), once a day old (as
 * installs are swept): their packages' store entries are freed with them (sweepStore).
 */
async function sweepSideInstalls(root: string): Promise<void> {
  const day = Date.now() - 24 * 3600_000;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name);
    const done = await readFile(join(dir, '.sandburg-complete'), 'utf8').catch(() => null);
    // Side installs from before the layout was recorded are of an older layout too.
    const stale = name.includes('.tmp-') || (done !== null && /layout (\d+)/.exec(done)?.[1] !== String(LAYOUT_VERSION));
    const st = await lstat(dir).catch(() => null);
    if (st && stale && st.mtimeMs < day) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A side install (a WebAssembly build or binding with its dependencies, which installs copy into
 * place): npm installs each package.json once, as with installs themselves (the versions npm picks
 * first stay), so every Vite app does not pay ~1 s of npm for the same lightningcss-wasm.
 */
function sideInstall(sides: Sides, manifest: object, flags: string[], log: (line: string) => void): Promise<string> {
  const root = sides.root;
  const key = createHash('sha256').update(`layout:${LAYOUT_VERSION}\0`).update(JSON.stringify([manifest, flags])).digest('hex').slice(0, 24);
  let pending = sideInstalls.get(key);
  if (!pending) {
    pending = (async () => {
      const dir = join(root, key);
      if (await access(join(dir, '.sandburg-complete')).then(() => true, () => false)) return dir;
      const tmp = `${dir}.tmp-${tmpSuffix()}`;
      await mkdir(tmp, { recursive: true });
      try {
        await writeFile(join(tmp, 'package.json'), JSON.stringify(manifest));
        // As an install: npm resolves (in the resolver's worker, beside others: these are small), the
        // store unpacks; npm installs what the store does not handle.
        const force = flags.includes('--force');
        if (!(await sides.resolver.resolve(tmp, log, { force, small: true }))) await run('npm', ['install', '--package-lock-only', ...flags], tmp, log);
        if (!(await installFromLockfile(tmp, sides.store, log, false))) {
          // From its package.json alone, as before: npm installing from a lockfile skips its libc
          // check for optional packages (sass's @parcel/watcher-linux-x64-musl would come along).
          await rm(join(tmp, 'package-lock.json'), { force: true });
          await run('npm', ['install', ...flags], tmp, log);
        }
        await mkdir(join(tmp, 'node_modules'), { recursive: true });
        await writeFile(join(tmp, '.sandburg-complete'), `${new Date().toISOString()} layout ${LAYOUT_VERSION}\n`);
        // Another process may have finished the same side install first.
        await rename(tmp, dir).catch(async (e) => {
          if (!(await access(join(dir, '.sandburg-complete')).then(() => true, () => false))) throw e;
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return dir;
    })();
    sideInstalls.set(key, pending);
    pending.catch(() => sideInstalls.delete(key));
  }
  return pending;
}
const sideInstalls = new Map<string, Promise<string>>();

/** Where side installs are kept, and how they are made. */
interface Sides {
  root: string;
  store: string;
  resolver: Resolver;
}

/**
 * Whether a package version exists on the registry (npm view). Asked once per process: a Next.js app
 * and its seed both ask for @next/swc-wasm32-wasi (which does not exist), ~0.5 s each.
 */
function npmViewVersion(spec: string, resolver: Resolver): Promise<string | null> {
  let version = viewed.get(spec);
  if (!version) {
    version = resolver.view(spec).then((v) => (v === undefined ? npmView(spec) : v));
    viewed.set(spec, version);
  }
  return version;
}
const viewed = new Map<string, Promise<string | null>>();

function npmView(spec: string): Promise<string | null> {
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

/** The side install of a package's WebAssembly build (one per build and version: see sideInstall). */
function wasmBuild(sides: Sides, build: (typeof WASM_BUILDS)[number], version: string, log: (line: string) => void): Promise<string> {
  const dependencies = { [build.wasm]: build.wasmVersion ?? version };
  return sideInstall(sides, { name: 'sandburg-wasm-build', private: true, dependencies }, ['--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], log);
}

async function wasmBuildsFor(dir: string, sideRoot: Sides, packages: InstalledPackage[], log: (line: string) => void): Promise<() => Promise<void>> {
  const at = new Set(packages.map((p) => p.location));
  const found: { dir: string; version: string; build: (typeof WASM_BUILDS)[number]; side: Promise<string> | null }[] = [];
  const sides = new Map<string, Promise<string>>();
  for (const { location, version } of packages) {
    // Packages up to four node_modules deep.
    if (location.split('node_modules/').length > 6) continue;
    const build = WASM_BUILDS.find((b) => location === `node_modules/${b.name}` || location.endsWith(`/node_modules/${b.name}`));
    if (!build || !build.applies(version)) continue;
    let side: Promise<string> | null = null;
    if (!at.has(`${location}/node_modules/${build.wasm}`)) {
      const spec = `${build.wasm}@${build.wasmVersion ?? version}`;
      side = sides.get(spec) ?? null;
      if (!side) {
        side = wasmBuild(sideRoot, build, version, log);
        sides.set(spec, side);
      }
    }
    found.push({ dir: join(dir, location), version, build, side });
  }
  await Promise.all(sides.values());
  return async () => {
    for (const { dir: pkgDir, version, build, side } of found) {
      if (!existsSyncSafe(join(pkgDir, build.file))) continue;
      const target = join(pkgDir, 'node_modules', build.wasm);
      if (side && !existsSyncSafe(join(target, 'package.json'))) {
        const sideNm = join(await side, 'node_modules');
        await place(join(sideNm, build.wasm), target);
        // Its own dependencies (lightningcss-wasm's napi-wasm) go inside it.
        for (const entry of await readdir(sideNm, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const names = entry.name.startsWith('@') ? (await readdir(join(sideNm, entry.name))).map((n) => `${entry.name}/${n}`) : [entry.name];
          for (const dep of names) if (dep !== build.wasm) await place(join(sideNm, dep), join(target, 'node_modules', dep));
        }
      }
      await replaceFile(join(pkgDir, build.file), build.shim);
      for (const [file, shim] of Object.entries(build.also ?? {})) await replaceFile(join(pkgDir, file), shim);
      log(`${build.name} ${version}: using ${build.wasm}`);
    }
  };
}

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
  const from = join(dir, NEXT_SWC_WASM.from);
  const next = join(dir, 'node_modules', 'next');
  if (!(await access(from).then(() => true, () => false)) || !(await access(next).then(() => true, () => false))) return;
  const to = join(dir, NEXT_SWC_WASM.to);
  await rm(to, { recursive: true, force: true });
  await place(from, to);
}

/**
 * A package directory of a side install (or of this install) put in place: its files hard-linked,
 * as the store links them (a copy each was ~0.5 s of an Astro app's install), or copied where that
 * fails. Installs replace their files, never write them in place (replaceFile), so links are safe.
 */
async function place(from: string, to: string): Promise<void> {
  try {
    linkTree(from, to);
  } catch {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  }
}

async function buildIndex(dir: string): Promise<FileIndex> {
  const index: FileIndex = {};
  // Synchronous: 0.1-0.2 s for the 10,500 files of a Next.js install, where awaiting each lstat took
  // 1.1-1.3 s (0.6 s with each directory's entries side by side). Once per install and process.
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.cache' || entry.name === '.sandburg-transformed') continue;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) index[relative(dir, full).split(sep).join('/')] = lstatSync(full).size;
      // npm does not create symlinks without workspaces; others are skipped
    }
  }
  walk(join(dir, 'node_modules'));
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
