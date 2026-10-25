/**
 * npm's resolution of an install (`npm install --package-lock-only`), run by npm's own code in a
 * worker thread that lives across installs (ADR 0032). Most of a resolution's time goes to reading
 * and parsing full packuments (Vite's is 39 MB, and every package that peers on Vite fetches it and
 * its optional peers'), which npm keeps in memory only for one run, and only when under 1 MB. Here
 * they stay in memory between installs (up to PACKUMENT_BYTES), so the second Vite app of a batch
 * does not parse Vite again: vite-react-counter after lit-vite resolves in 0.75 s instead of 3.6 s.
 *
 * It is the npm the CLI would run (the `npm` on PATH): its `lib/npm.js` loads the configuration as
 * the CLI does in an install directory (the same user, global and environment settings and flags),
 * and its Arborist resolves and writes the lockfile, as `npm install` does. When any of that is not
 * there (another npm layout, Windows) or fails, resolve() returns false and the caller runs the CLI.
 * A resolution already running in the worker also sends the next to the CLI, so installs side by
 * side do not wait for each other.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { createRequire, enableCompileCache } from 'node:module';
import { dirname, join } from 'node:path';
import { format } from 'node:url';
import { Writable } from 'node:stream';
import { UnsupportedDependencyError } from './spec-guard.ts';

/** Bytes of packuments (by their length on the wire) the worker keeps. */
const PACKUMENT_BYTES = 96 << 20;
/** A worker idle this long ends, and its packuments go with it. */
const IDLE_MS = 30_000;

const WORKER_TAG = 'sandburg-npm-resolver';
/** Marks a resolution refused because a dependency is not a registry package (carried in the worker's error message). */
const NON_REGISTRY_MARK = 'sandburg-non-registry-dependency';
/** Packuments read ahead at once (most of the wait is the registry's, for stale cache entries). */
const READ_AHEAD = 4;
/** The spec types pacote fetches from a registry's packuments. */
const REGISTRY_SPECS = new Set(['version', 'range', 'tag']);

interface Init {
  tag: string;
  npmRoot: string;
  /** A directory with a package.json and no .npmrc, as each install directory is: npm's local prefix. */
  configDir: string;
  flags: string[];
}

/** In the worker: loads npm once, then resolves each directory it is sent. */
async function serve({ npmRoot, configDir, flags }: Init): Promise<void> {
  // As npm's CLI does (bin/npm-cli.js): its modules load from V8's code cache. In .sandburg/ (beside
  // the installs), as the CLI's own (bin/sandburg.js), not in the temporary directory other users share.
  enableCompileCache?.(process.env.NODE_COMPILE_CACHE || join(configDir, '..', '..', 'node-compile-cache'));
  const require = createRequire(join(npmRoot, 'package.json'));
  // npm's configuration also reads process.argv: only the flags count, as on the command line.
  process.argv = [process.execPath, join(npmRoot, 'bin', 'npm-cli.js')];
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
  let ready: Promise<{ flat: object; Arborist: new (o: object) => { reify(o: object): Promise<unknown> } }> | null = null;
  const cache = new PackumentCache(PACKUMENT_BYTES);
  // Before npm loads: pacote's packuments are parsed through minipass-fetch's Body.json.
  const trimmed = new TrimmedPackuments(require);
  trimmed.install();
  // The packages npm picks, as it goes: the host unpacks them meanwhile (package-store.ts's unpackHint).
  const ahead = new ReadAhead(require, cache, (picked) => parentPort!.postMessage({ picked }));
  /** Resolutions running (a small one runs beside another). */
  let active = 0;
  parentPort!.on('message', async ({ id, dir, force, view }: { id: number; dir: string; force: boolean; view?: string }) => {
    try {
      ready ??= (async () => {
        const Npm = require('./lib/npm.js') as new (o: object) => { config: { cwd: string }; load(): Promise<unknown>; flatOptions: object };
        const npm = new Npm({ argv: ['install', ...flags], stdout: sink, stderr: sink });
        npm.config.cwd = configDir;
        await npm.load();
        trimmed.cacheDir = String((npm.flatOptions as { cache?: unknown }).cache ?? '') || null;
        return { flat: npm.flatOptions, Arborist: require('@npmcli/arborist') };
      })();
      const { flat, Arborist } = await ready;
      if (view !== undefined) {
        // As `npm view <spec> version` answers whether a version matches: pacote picks one from the
        // packument, with npm's options and this worker's packuments.
        const pacote = require('pacote') as Pacote;
        const version = await pacote.manifest(view, { ...flat, fullMetadata: true, packumentCache: cache }).then((m) => String(m.version), () => null);
        return parentPort!.postMessage({ id, version });
      }
      ahead.start(dir, !active++);
      // As lib/commands/install.js runs it, with this worker's packuments.
      const opts = { ...flat, ...(force ? { force: true } : {}), npmCommand: 'install', auditLevel: null, path: dir, add: [], workspaces: undefined, packumentCache: cache };
      try {
        await new Arborist(opts).reify(opts);
      } finally {
        active--;
      }
      parentPort!.postMessage({ id });
    } catch (e) {
      parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

type Packument = { _contentLength?: number };

/**
 * pacote's packument cache, keeping large packuments too: least recently used out first. A
 * packument being read ahead (pending) is there too: pacote awaits what get() returns.
 */
export class PackumentCache extends Map<string, Packument> {
  private bytes = 0;
  private readonly max: number;
  private reading = new Map<string, Promise<Packument>>();
  constructor(max: number) {
    super();
    this.max = max;
  }
  /** `read` is a packument being read ahead; one that fails is read again (`again`) for whoever waits for it. */
  pending(key: string, read: Promise<Packument>, again: () => Promise<Packument>): void {
    const shared: Promise<Packument> = read.then(
      (packument) => {
        if (this.reading.get(key) === shared) this.reading.delete(key);
        this.set(key, packument);
        return packument;
      },
      () => {
        if (this.reading.get(key) === shared) this.reading.delete(key);
        return again();
      },
    );
    shared.catch(() => {});
    this.reading.set(key, shared);
  }
  /** Packuments pacote is reading itself: it asks has() just before, and set()s or delete()s after. */
  private fetching = new Set<string>();
  override has(key: string) {
    const known = this.reading.has(key) || super.has(key);
    if (!known) this.fetching.add(key);
    return known;
  }
  /** Whether a packument is here, being read ahead, or being read by pacote. */
  knows(key: string): boolean {
    return this.reading.has(key) || this.fetching.has(key) || super.has(key);
  }
  override get(key: string) {
    const reading = this.reading.get(key);
    if (reading) return reading as Packument;
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  override set(key: string, value: Packument) {
    this.delete(key);
    this.fetching.delete(key);
    const size = value?._contentLength ?? 0;
    // Without a length it cannot be counted, so it is not kept (as npm's own cache does).
    if (!size || size > this.max / 2) return this;
    super.set(key, value);
    this.bytes += size;
    for (const k of super.keys()) {
      if (this.bytes <= this.max) break;
      this.delete(k);
    }
    return this;
  }
  override delete(key: string) {
    this.fetching.delete(key);
    const value = super.get(key);
    if (value !== undefined) this.bytes -= value._contentLength ?? 0;
    return super.delete(key);
  }
}

type Options = Record<string, unknown>;

/**
 * Packuments without what npm's resolution never reads, kept in npm's own cache beside the
 * packuments they come from. A full packument is mostly fields no install looks at: Vite's 39 MB is
 * 35 MB of a `licenseText` in each version; npm's cache of 523 packuments here was 498 MB, of which
 * readmes, maintainers, `exports`, dev dependencies, legacy PGP signatures and the like are half. And
 * reading one is most of a resolution's CPU (lit-vite's: JSON.parse 0.6 s, decoding 0.3 s, cacache's
 * integrity check 0.23 s, garbage collection 0.27 s, of 2.35 s).
 *
 * When pacote parses a packument that make-fetch-happen serves from npm's cache (fresh, or
 * revalidated with a 304: the same bytes), a helper thread parses those bytes again, drops the
 * fields below and stores the rest under a key of its own (TRIM_PREFIX + the cache entry's key),
 * with the integrity of the bytes it came from. A later read of the same cache entry with the same
 * integrity is answered with the trimmed packument and leaves the cached body unread; any other
 * (a newer packument, an entry from the registry, a trimmed one cacache's integrity check refuses)
 * is read as before. npm's cache decides freshness and revalidation as before: only the bytes of the
 * body it answers with are replaced by what they trim to. Lockfiles are the same as with full
 * packuments (resolver.test.ts, and the fixtures' installs).
 */
const TRIM_PREFIX = 'sandburg:packument-trim:1:';
const TRIM_TAG = 'sandburg-packument-trim';
/** Smaller packuments are read as they are: looking up a trimmed one costs about as much as parsing. */
const TRIM_MIN = 64 << 10;
/** Bytes of packuments waiting for the helper; more are not trimmed (this time). */
const TRIM_QUEUE = 64 << 20;
const TRIMMED_FIELDS = new Set(['readme', 'readmeFilename', 'users', 'keywords', 'description', 'maintainers', 'contributors', 'author', 'bugs', 'homepage', 'repository']);
const TRIMMED_VERSION_FIELDS = new Set([
  ...TRIMMED_FIELDS,
  'licenseText',
  '_npmOperationalInternal',
  '_npmUser',
  '_nodeVersion',
  '_npmVersion',
  'gitHead',
  'exports',
  'imports',
  'types',
  'typings',
  'typesVersions',
  'devDependencies',
  'files',
  'module',
  'browser',
  'sideEffects',
  'publishConfig',
  'jest',
  'eslintConfig',
  'prettier',
  'lint-staged',
  'husky',
  '//',
]);
/** Signatures and attestations are read only by `npm audit signatures` (pacote's verifySignatures). */
const TRIMMED_DIST_FIELDS = new Set(['npm-signature', 'signatures', 'attestations', 'fileCount', 'unpackedSize']);

const omit = (o: Record<string, unknown>, fields: Set<string>) => Object.fromEntries(Object.entries(o).filter(([k]) => !fields.has(k)));

/** A packument without the fields npm's resolution does not read; null if it is not one. */
export function trimPackument(packument: unknown): Record<string, unknown> | null {
  if (!packument || typeof packument !== 'object') return null;
  const p = packument as Record<string, unknown>;
  if (!p.versions || typeof p.versions !== 'object' || typeof p.name !== 'string') return null;
  const versions: Record<string, unknown> = {};
  for (const [version, manifest] of Object.entries(p.versions as Record<string, unknown>)) {
    if (!manifest || typeof manifest !== 'object') return null;
    const m = omit(manifest as Record<string, unknown>, TRIMMED_VERSION_FIELDS);
    if (m.dist && typeof m.dist === 'object') m.dist = omit(m.dist as Record<string, unknown>, TRIMMED_DIST_FIELDS);
    versions[version] = m;
  }
  return { ...omit(p, TRIMMED_FIELDS), versions };
}

interface Cacache {
  get: {
    info(cache: string, key: string): Promise<{ integrity: string; metadata?: { source?: string } } | null>;
    byDigest(cache: string, integrity: string): Promise<Buffer>;
  };
  put(cache: string, key: string, data: string | Buffer, options: { metadata: object }): Promise<unknown>;
}
interface CachedResponse {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * The packument cache entry a response came from: npm's cache, its key and the body's integrity.
 * Only an entry in npm's own cache (cacheDir) counts: make-fetch-happen passes a response it does not
 * store (`Cache-Control: no-store`) with the registry's headers, which could name any directory.
 */
export function cachedBody(res: CachedResponse, cacheDir: string | null): { cache: string; key: string; source: string } | null {
  const [cache, key, source] = ['x-local-cache', 'x-local-cache-key', 'x-local-cache-hash'].map((h) => res.headers.get(h));
  if (!cacheDir || res.status !== 200 || !cache || !key || !source || Number(res.headers.get('content-length')) < TRIM_MIN) return null;
  try {
    const entry = { cache: decodeURIComponent(cache), key: decodeURIComponent(key), source: decodeURIComponent(source) };
    return entry.cache === cacheDir && entry.key.startsWith('make-fetch-happen:request-cache:') ? entry : null;
  } catch {
    return null;
  }
}

class TrimmedPackuments {
  /** npm's cache (its flat options' `cache`), once npm has loaded; nothing is trimmed before. */
  cacheDir: string | null = null;
  private readonly require: NodeJS.Require;
  private cacache!: Cacache;
  private helper: Worker | null = null;
  private queued = 0;

  constructor(require: NodeJS.Require) {
    this.require = require;
  }

  /** Answers pacote's res.json() with trimmed packuments; false if minipass-fetch is not as expected (all is read as before). */
  install(): boolean {
    try {
      this.cacache = this.require('cacache') as Cacache;
      const Body = this.require('minipass-fetch/lib/body.js') as { prototype: Record<string | symbol, unknown> };
      const consume = Object.getOwnPropertySymbols(Body.prototype).find((s) => s.description === 'consumeBody');
      const json = Body.prototype.json as (this: unknown) => Promise<unknown>;
      if (!consume || typeof json !== 'function') return false;
      const self = this;
      Body.prototype.json = async function (this: CachedResponse & Record<symbol, () => Promise<Buffer>>) {
        const entry = cachedBody(this, self.cacheDir);
        if (!entry) return json.call(this);
        const trimmed = await self.read(entry);
        if (trimmed) return trimmed;
        // The body's bytes, as json() reads them, go to the helper too.
        const read = this[consume];
        this[consume] = async function (this: unknown) {
          const bytes = await read.call(this);
          self.offer(entry, bytes);
          return bytes;
        };
        return json.call(this);
      };
      return true;
    } catch {
      return false;
    }
  }

  private async read({ cache, key, source }: { cache: string; key: string; source: string }): Promise<unknown> {
    try {
      const info = await this.cacache.get.info(cache, TRIM_PREFIX + key);
      if (!info || info.metadata?.source !== source) return null;
      // byDigest checks the bytes against their integrity: a trimmed entry that changed is refused.
      return JSON.parse((await this.cacache.get.byDigest(cache, info.integrity)).toString());
    } catch {
      return null;
    }
  }

  private offer(entry: { cache: string; key: string; source: string }, bytes: Buffer): void {
    if (this.queued + bytes.length > TRIM_QUEUE) return;
    try {
      this.helper ??= this.startHelper();
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      this.queued += bytes.length;
      this.helper.postMessage({ ...entry, bytes: copy }, [copy.buffer]);
    } catch {
      // not trimmed this time
    }
  }

  private startHelper(): Worker {
    const helper = new Worker(new URL(import.meta.url), { workerData: { tag: TRIM_TAG, cacache: dirname(this.require.resolve('cacache/package.json')) } });
    helper.unref();
    helper.on('message', (bytes: number) => (this.queued -= bytes));
    helper.on('error', () => {
      if (this.helper === helper) this.helper = null;
    });
    return helper;
  }
}

/** In the helper thread: trims each packument it is sent and stores it in npm's cache. */
function trimInHelper({ cacache: dir }: { cacache: string }): void {
  const cacache = createRequire(join(dir, 'package.json'))('cacache') as Cacache;
  // The lowest priority, where a thread has one of its own (Linux): what it does can wait for
  // the resolution and the run beside it.
  try {
    setPriority(Number(readlinkSync('/proc/thread-self').split('/').pop()), 19);
  } catch {
    // another system
  }
  let chain = Promise.resolve();
  parentPort!.on('message', ({ cache, key, source, bytes }: { cache: string; key: string; source: string; bytes: Uint8Array }) => {
    chain = chain.then(async () => {
      try {
        const trimmed = trimPackument(JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString()));
        if (trimmed) await cacache.put(cache, TRIM_PREFIX + key, JSON.stringify(trimmed), { metadata: { source } });
      } catch {
        // not trimmed
      } finally {
        parentPort!.postMessage(bytes.byteLength);
      }
    });
  });
}

/** A package a resolution picks: its name, version, tarball's integrity, and the optional dependencies its manifest lists. */
export interface Picked {
  name: string;
  version: string;
  integrity: string;
  optionalDependencies?: Record<string, string>;
}
interface Spec {
  type: string;
  name: string;
  rawSpec: string;
  escapedName: string;
}
interface Pacote {
  manifest(spec: unknown, opts: Options): Promise<Record<string, unknown>>;
  packument(spec: unknown, opts: Options): Promise<Packument>;
}
interface Npa {
  (spec: string): Spec;
  resolve(name: string, spec: string): Spec;
}

/** A cache index entry of make-fetch-happen's, as cacache returns it. */
interface CacheEntry {
  time?: number;
  metadata?: { resHeaders?: Record<string, string> };
}

/**
 * Whether npm would ask the registry about a cached packument before using it: always with
 * --prefer-online, never offline or with --prefer-offline, else once it is older than its
 * Cache-Control max-age (5 minutes on npmjs.org). Only a guess of make-fetch-happen's rule, for
 * deciding what to read ahead: the reading itself is npm's.
 */
export function revalidates(entry: CacheEntry, opts: Options): boolean {
  if (opts.offline || opts.preferOffline) return false;
  if (opts.preferOnline) return true;
  const control = entry.metadata?.resHeaders?.['cache-control'] ?? '';
  const maxAge = /(?:^|,)\s*max-age=(\d+)/.exec(control)?.[1];
  if (!maxAge || /no-cache|no-store/.test(control)) return true;
  return Date.now() - (entry.time ?? 0) >= Number(maxAge) * 1000;
}

/**
 * Reads ahead, while npm resolves, the stale packuments it will ask for next. npm reads a package's
 * peers one after the other (build-ideal-tree's #loadPeerSet), and for each a cache entry older
 * than the registry's max-age (5 minutes for npmjs.org) waits for the registry to revalidate it:
 * lit-vite's resolution took 4.1 s with every entry stale, 2.0 s with every entry fresh. Here, as
 * each manifest comes back, the packuments of the packages it brings in are read (revalidated, if
 * stale) side by side, into the cache npm reads from, as npm would read them itself: the same
 * requests, with the same options, only earlier. A package npm places has its dependencies,
 * optional dependencies and peers loaded; one it loads only as an optional peer (Vite's vitest,
 * vitest's playwright) has only its peers loaded, unless something depends on it; a dependency's
 * own dev dependencies are never installed. Only packuments npm's cache has, and that npm would
 * revalidate, are read ahead: a wrong guess never goes to the registry for a package npm has not
 * fetched before, and a fresh entry is left to npm (reading it ahead would only reorder npm's own
 * parsing on its thread, which slowed next-app-router's resolution by ~0.4 s).
 */
class ReadAhead {
  private readonly npa: Npa;
  private readonly pacote: Pacote;
  private readonly cacache: { get: { info(cache: string, key: string): Promise<unknown> } };
  private readonly registryFetch: { pickRegistry(spec: Spec, opts: Options): string };
  private readonly cache: PackumentCache;
  /** Names a resolution's starting lockfile has: npm does not fetch them. */
  private locked = new Set<string>();
  /** Names npm places in the tree (as far as the manifests read so far tell), and the manifests read. */
  private placed = new Set<string>();
  private manifests = new Map<string, Record<string, unknown>>();
  private seen = new Set<string>();
  private queue: (() => Promise<void>)[] = [];
  private running = 0;

  private readonly picked: (package_: Picked) => void;

  constructor(require: NodeJS.Require, cache: PackumentCache, picked: (package_: Picked) => void) {
    this.picked = picked;
    this.npa = require('npm-package-arg') as Npa;
    this.pacote = require('pacote') as Pacote;
    this.cacache = require('cacache') as ReadAhead['cacache'];
    this.registryFetch = require('npm-registry-fetch') as ReadAhead['registryFetch'];
    this.cache = cache;
    const original = this.pacote.manifest.bind(this.pacote);
    this.pacote.manifest = async (spec, opts) => {
      // Before pacote fetches a manifest: a git, directory or remote-tarball dependency's manifest is
      // the clone or the tarball itself, so refusing here means it is never fetched during resolution.
      this.ensureRegistry(spec);
      const manifest = await original(spec, opts);
      // As build-ideal-tree's #fetchManifest asks (an old lockfile's inflation asks for less).
      if (opts.fullMetadata) this.read(manifest, opts);
      return manifest;
    };
  }

  /** Throws (marked) for a spec that is not a registry package, before pacote fetches it. */
  private ensureRegistry(spec: unknown): void {
    type Resolved = Spec & { subSpec?: Resolved; raw?: string };
    let s: Resolved | null = null;
    try {
      s = (typeof spec === 'string' ? this.npa(spec) : spec) as Resolved;
    } catch {
      return; // not classifiable here; the lockfile checks catch it before extraction
    }
    const registry = (r: Resolved | null | undefined): boolean => {
      if (!r || typeof r.type !== 'string') return true;
      if (REGISTRY_SPECS.has(r.type)) return true;
      if (r.type === 'alias') return registry(r.subSpec);
      return false;
    };
    if (!registry(s)) throw new Error(`${NON_REGISTRY_MARK}: ${s?.raw ?? String(spec)} is not a registry package`);
  }

  /** A resolution of dir starts. What the last one learnt goes, unless another is still running (`alone`). */
  start(dir: string, alone: boolean): void {
    if (alone) {
      this.locked.clear();
      this.placed.clear();
      this.manifests.clear();
      this.seen.clear();
    }
    try {
      const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { packages?: Record<string, unknown> };
      for (const location of Object.keys(lock.packages ?? {})) this.locked.add(location.slice(location.lastIndexOf('node_modules/') + 13));
    } catch {
      // none: npm resolves every dependency
    }
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) for (const name of Object.keys(pkg[field] ?? {})) this.placed.add(name);
    } catch {
      // npm reports it
    }
  }

  private read(manifest: Record<string, unknown>, opts: Options): void {
    const name = typeof manifest.name === 'string' ? manifest.name : '';
    this.manifests.set(name, manifest);
    const placed = this.placed.has(name);
    if (placed && typeof manifest._integrity === 'string') {
      this.picked({ name, version: String(manifest.version), integrity: manifest._integrity, optionalDependencies: manifest.optionalDependencies as Record<string, string> | undefined });
    }
    const optionalPeers = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean } | undefined>;
    for (const field of placed ? ['dependencies', 'optionalDependencies', 'peerDependencies'] : ['peerDependencies']) {
      const deps = manifest[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [dep, range] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof range !== 'string' || this.locked.has(dep)) continue;
        // A package npm installs: its own dependencies are wanted too (from its manifest, if read already).
        if (placed && (field !== 'peerDependencies' || !optionalPeers[dep]?.optional) && !this.placed.has(dep)) {
          this.placed.add(dep);
          const known = this.manifests.get(dep);
          if (known) this.read(known, opts);
        }
        this.packument(dep, range, opts);
      }
    }
  }

  private packument(name: string, range: string, opts: Options): void {
    let spec: Spec;
    try {
      spec = this.npa.resolve(name, range);
    } catch {
      return;
    }
    if (!REGISTRY_SPECS.has(spec.type)) return;
    // pacote's own URL and cache key for it (registry.js).
    const url = `${String(this.registryFetch.pickRegistry(spec, opts)).replace(/\/+$/, '')}/${spec.escapedName}`;
    const key = `full:${url}`;
    if (this.seen.has(key) || this.cache.knows(key)) return;
    this.seen.add(key);
    // As build-ideal-tree's #fetchManifest asks for it: not with the package's own resolved URL and
    // integrity that this manifest's options may carry (pacote ignores both for a packument).
    const options = { ...opts, fullMetadata: true, packumentCache: undefined, resolved: undefined, integrity: undefined, avoid: undefined };
    this.queue.push(async () => {
      const entry = `make-fetch-happen:request-cache:${format(new URL(url), { auth: false, fragment: false, search: true, unicode: false })}`;
      const cached = (await this.cacache.get.info(String(opts.cache), entry)) as CacheEntry | null;
      // A fresh entry is read from npm's cache without the registry: reading it ahead would only
      // move npm's parsing earlier on its own thread, ahead of what it waits for.
      if (!cached || !revalidates(cached, opts) || this.cache.knows(key)) return;
      const read = () => this.pacote.packument(spec, options);
      const reading = read();
      this.cache.pending(key, reading, read);
      await reading;
    });
    this.drain();
  }

  private drain(): void {
    while (this.running < READ_AHEAD && this.queue.length) {
      this.running++;
      void this.queue
        .shift()!()
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}

/** The npm package the CLI on PATH runs, if it has the layout this uses. */
function npmRoot(): string | null {
  if (process.platform === 'win32') return null;
  try {
    const bin = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    const root = dirname(dirname(realpathSync(bin)));
    return existsSync(join(root, 'lib', 'npm.js')) && existsSync(join(root, 'node_modules', '@npmcli', 'arborist')) ? root : null;
  } catch {
    return null;
  }
}

export class Resolver {
  private worker: Worker | null = null;
  private root: string | null | undefined;
  /** A resolution that is not small is running. */
  private large = false;
  private inflight = 0;
  private next = 0;
  private waiting = new Map<number, (answer: { error?: string; version?: string | null }) => void>();
  /** The requests each worker has: one that ends fails only its own (a stopped one exits after its successor starts). */
  private owned = new WeakMap<Worker, Set<number>>();
  private idle: ReturnType<typeof setTimeout> | null = null;

  private readonly dir: string;
  private readonly flags: string[];
  /** Gets the integrity of each package a resolution picks, as it goes (a guess: npm may pick another in the end). */
  onPicked: ((package_: Picked) => void) | null = null;

  /** `dir`: where its config directory goes (no .npmrc of its own, as an install directory). */
  constructor(dir: string, flags: string[]) {
    this.dir = dir;
    this.flags = flags;
  }

  /**
   * Writes dir/package-lock.json for dir/package.json (and the lockfile it starts from), as
   * `npm install --package-lock-only <flags>` would (with --force: `force`). False: not done; run
   * the CLI. A `small` resolution (a side install of one or two packages) runs beside others; any
   * other waits for none: while one runs, it is the CLI's.
   */
  async resolve(dir: string, log: (line: string) => void, options: { force?: boolean; small?: boolean } = {}): Promise<boolean> {
    if (this.large && !options.small) return false;
    this.root ??= npmRoot();
    if (!this.root) return false;
    if (!options.small) this.large = true;
    try {
      const { error } = await this.ask({ dir, force: !!options.force });
      if (error === undefined) return true;
      // A non-registry dependency is refused outright: falling back to the CLI would only let it
      // fetch what the worker would not. The caller reports it as unsupported.
      if (error.includes(NON_REGISTRY_MARK)) {
        const detail = error.slice(error.indexOf(NON_REGISTRY_MARK) + NON_REGISTRY_MARK.length + 2);
        throw new UnsupportedDependencyError(`only registry versions can be installed: ${detail}`);
      }
      log(`npm (in process): ${error.split('\n')[0]}; npm resolves again`);
      return false;
    } finally {
      if (!options.small) this.large = false;
    }
  }

  /**
   * The version `npm view <spec> version` would print first (one that matches), null when none does
   * or the registry cannot tell, or undefined when there is no worker to ask (run `npm view`).
   * Answered beside resolutions, without a process of its own (an npm process each was ~0.5 s).
   */
  async view(spec: string): Promise<string | null | undefined> {
    this.root ??= npmRoot();
    if (!this.root) return undefined;
    const { error, version } = await this.ask({ view: spec });
    return error === undefined ? (version ?? null) : undefined;
  }

  private async ask(message: { dir: string; force: boolean } | { view: string }): Promise<{ error?: string; version?: string | null }> {
    this.inflight++;
    if (this.idle) clearTimeout(this.idle);
    try {
      return await new Promise((done) => {
        const id = this.next++;
        this.waiting.set(id, done);
        const worker = this.start();
        this.owned.get(worker)!.add(id);
        // Held while it works; otherwise it does not keep the process alive.
        worker.ref();
        worker.postMessage({ id, ...message });
      });
    } finally {
      if (!--this.inflight) {
        this.worker?.unref();
        this.idle = setTimeout(() => this.stop(), IDLE_MS);
        this.idle.unref();
      }
    }
  }

  /**
   * Starts the worker, which loads npm and resolves an empty project (Arborist's code compiled and
   * warm), unless it runs already: ~0.3 s that a first resolution then does not wait for. It ends
   * after IDLE_MS without installs, as after any resolution.
   */
  warm(): void {
    if (this.worker) return;
    const dir = join(this.dir, '.npm-resolver-warm');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"sandburg-warm","private":true}\n');
    } catch {
      return;
    }
    // A warm-up that fails (the worker does not start) is only a lost head start.
    this.resolve(dir, () => {}, { small: true }).catch(() => {});
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const configDir = join(this.dir, '.npm-resolver');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'package.json'), '{}\n');
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { tag: WORKER_TAG, npmRoot: this.root!, configDir, flags: this.flags } satisfies Init,
    });
    worker.unref();
    const mine = new Set<number>();
    this.owned.set(worker, mine);
    worker.on('message', ({ id, error, picked, version }: { id: number; error?: string; picked?: Picked; version?: string | null }) => {
      if (picked) return this.onPicked?.(picked);
      this.waiting.get(id)?.({ error, version });
      this.waiting.delete(id);
      mine.delete(id);
    });
    const fail = (e: unknown) => {
      for (const id of mine) {
        this.waiting.get(id)?.({ error: e instanceof Error ? e.message : String(e) });
        this.waiting.delete(id);
      }
      mine.clear();
      if (this.worker === worker) this.worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error('the resolver ended')));
    this.worker = worker;
    return worker;
  }

  private stop(): void {
    if (this.inflight) return;
    void this.worker?.terminate();
    this.worker = null;
  }
}

// Last: the worker needs the classes above.
if (!isMainThread && (workerData as Init | null)?.tag === WORKER_TAG) void serve(workerData as Init);
if (!isMainThread && (workerData as { tag?: string } | null)?.tag === TRIM_TAG) trimInHelper(workerData as { cacache: string });
