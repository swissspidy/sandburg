/**
 * The files a never-run install's programs will load, transformed ahead and preloaded (cold runs).
 * The runtime loads installed files with one synchronous request each until it has a preload bundle,
 * and a bundle lists the files earlier runs loaded: a cold machine has none. Each request waited for
 * its file's transform in turn (~1,300 of them for next dev) while the host's other cores idled.
 *
 * So, from a program's entry and from each file the runtime asks for, the modules a file requires
 * are found in its transformed code (where ES imports and import() are require calls too), resolved
 * as the runtime's loader resolves them, and transformed a few at a time. A request for a file in
 * progress waits for that transform (Installer.file), and the install's first preload bundle is
 * what this found (see preloadBundle in index.ts).
 *
 * What is resolved here only decides what is transformed and sent early: the runtime still resolves
 * and loads every module itself, and asks for what is not in the bundle. A guess that is never loaded
 * (a require behind a condition) costs a transform, cached for later runs, and bundle space.
 */
import type { FileIndex, Installer } from './install.ts';
import { ESM_MARKER, IMPORT_CONDITIONS, REQUIRE_CONDITIONS } from '../../node-runtime/names.ts';

const REQUIRE = /\brequire\(\s*(["'])([^"'\n\\]+)\1\s*\)/g;

/**
 * Transforms in progress at a time. esbuild does a transform in its own process, on its own threads;
 * the host's part of one is small (reading, hashing and patching the file), and the prefetch finds
 * a file's requires only once it is transformed, so more at a time shortens the chain.
 */
const CONCURRENCY = 8;

interface PackageJson {
  main?: string;
  exports?: unknown;
}

export class Prefetcher {
  /** Files transformed, in the order they were found, and raw files read (package.json, JSON modules). */
  readonly transformed: string[] = [];
  readonly raw = new Set<string>();
  private installer: Installer;
  private key: string;
  private index: FileIndex;
  private seen = new Set<string>();
  private queue: string[] = [];
  private running = 0;
  private scans = 0;
  private idleWaiters: (() => void)[] = [];
  private packages = new Map<string, Promise<PackageJson | null>>();

  constructor(installer: Installer, key: string, index: FileIndex) {
    this.installer = installer;
    this.key = key;
    this.index = index;
  }

  /** A file the runtime loaded (transformed): prefetch what it requires. */
  loaded(rel: string, code: string): void {
    if (this.seen.has(`scan:${rel}`)) return;
    this.seen.add(`scan:${rel}`);
    this.seen.add(rel);
    void this.scan(rel, code);
  }

  /** What `require(request)` from the project's root loads, transformed before it is asked for (a program's entry). */
  async require(request: string): Promise<void> {
    const found = await this.resolve(request, '', REQUIRE_CONDITIONS).catch(() => null);
    if (found) this.add(found);
  }

  /** A file to transform before it is asked for (a program's entry). */
  add(rel: string): void {
    if (this.seen.has(rel) || !(rel in this.index)) return;
    if (!/\.(c|m)?js$/.test(rel)) {
      if (rel.endsWith('.json')) this.raw.add(rel);
      return;
    }
    this.seen.add(rel);
    this.queue.push(rel);
    this.pump();
  }

  /** Resolves when nothing is queued, transforming or being read. */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length && !this.scans) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** idle(), or after `ms`. */
  untilIdle(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([this.idle(), new Promise<void>((r) => (timer = setTimeout(r, ms)))]).finally(() => clearTimeout(timer));
  }

  private checkIdle(): void {
    if (this.running || this.queue.length || this.scans) return;
    for (const r of this.idleWaiters.splice(0)) r();
  }

  private async scan(rel: string, code: string): Promise<void> {
    this.scans++;
    try {
      const conditions = code.startsWith(ESM_MARKER) ? IMPORT_CONDITIONS : REQUIRE_CONDITIONS;
      const dir = rel.slice(0, rel.lastIndexOf('/'));
      for (const m of code.matchAll(REQUIRE)) {
        const found = await this.resolve(m[2], dir, conditions).catch(() => null);
        if (found) this.add(found);
      }
    } finally {
      this.scans--;
      this.checkIdle();
    }
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const rel = this.queue.shift()!;
      this.running++;
      void this.installer
        .file(this.key, rel)
        .then((f) => {
          if (!f) return;
          this.transformed.push(rel);
          // The runtime reads the package.json nearest to each module it loads (its "type").
          for (let dir = rel.slice(0, rel.lastIndexOf('/')); dir.includes('/'); dir = dir.slice(0, dir.lastIndexOf('/'))) {
            if (`${dir}/package.json` in this.index) {
              this.raw.add(`${dir}/package.json`);
              break;
            }
          }
          this.loaded(rel, f.body.toString('utf8'));
        })
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.pump();
          this.checkIdle();
        });
    }
  }

  /** The installed file `request` from a file in `dir` resolves to, or null (a builtin, the project's, not found). */
  private async resolve(request: string, dir: string, conditions: readonly string[]): Promise<string | null> {
    if (request.startsWith('node:') || request.startsWith('#') || request.startsWith('/')) return null;
    if (request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..') return this.tryPath(normalize(`${dir}/${request}`));
    const parts = request.split('/');
    const n = request.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, n).join('/');
    const subpath = parts.slice(n).join('/');
    // node_modules directories from the requiring file's up.
    const segments = dir ? dir.split('/') : [];
    for (let i = segments.length; i >= 0; i--) {
      if (i > 0 && segments[i - 1] === 'node_modules') continue;
      const pkgDir = i ? `${segments.slice(0, i).join('/')}/node_modules/${name}` : `node_modules/${name}`;
      if (!(`${pkgDir}/package.json` in this.index)) continue;
      const pkg = await this.packageJson(pkgDir);
      if (pkg?.exports !== undefined && pkg.exports !== null) {
        const target = exportsTarget(pkg.exports, subpath ? `./${subpath}` : '.', conditions);
        return target ? this.tryFile(normalize(`${pkgDir}/${target}`)) : null;
      }
      return this.tryPath(subpath ? `${pkgDir}/${subpath}` : pkgDir, pkg);
    }
    return null;
  }

  private tryFile(p: string): string | null {
    return p in this.index ? p : null;
  }

  private async tryPath(p: string, pkg?: PackageJson | null): Promise<string | null> {
    for (const candidate of [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`]) if (candidate in this.index) return candidate;
    if (`${p}/package.json` in this.index) {
      const main = (pkg ?? (await this.packageJson(p)))?.main;
      if (main) {
        const m = normalize(`${p}/${main}`);
        for (const candidate of [m, `${m}.js`, `${m}/index.js`]) if (candidate in this.index) return candidate;
      }
    }
    return `${p}/index.js` in this.index ? `${p}/index.js` : null;
  }

  private packageJson(pkgDir: string): Promise<PackageJson | null> {
    let pkg = this.packages.get(pkgDir);
    if (!pkg) {
      this.raw.add(`${pkgDir}/package.json`);
      pkg = this.installer
        .raw(this.key, `${pkgDir}/package.json`)
        .then((f) => (f ? (JSON.parse(f.body.toString('utf8')) as PackageJson | null) : null))
        .catch(() => null);
      this.packages.set(pkgDir, pkg);
    }
    return pkg;
  }
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** A package's "exports" target for a subpath, as the runtime's loader picks it (patterns included). */
function exportsTarget(exports: unknown, subpath: string, conditions: readonly string[]): string | null {
  let map = exports;
  if (typeof map === 'string' || Array.isArray(map) || (map && typeof map === 'object' && !Object.keys(map).some((k) => k.startsWith('.')))) map = { '.': map };
  const entries = map as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(entries, subpath) && !subpath.includes('*')) return target(entries[subpath], '', conditions);
  let best: { key: string; match: string } | null = null;
  for (const key of Object.keys(entries)) {
    const star = key.indexOf('*');
    if (star === -1) {
      if (key.endsWith('/') && subpath.startsWith(key) && (!best || key.length > best.key.length)) best = { key, match: subpath.slice(key.length) };
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1 && (!best || prefix.length > best.key.indexOf('*'))) {
      best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  return best ? target(entries[best.key], best.match, conditions, best.key.endsWith('/') && !best.key.includes('*')) : null;
}

function target(value: unknown, match: string, conditions: readonly string[], folder = false): string | null {
  if (typeof value === 'string') return folder ? value + match : value.replaceAll('*', match);
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = target(v, match, conditions, folder);
      if (r !== null) return r;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [cond, v] of Object.entries(value)) {
      if (!conditions.includes(cond)) continue;
      const r = target(v, match, conditions, folder);
      if (r !== null) return r;
    }
  }
  return null;
}
