/**
 * Preload bundles: the files an install's runs load (recorded as they load them, and predicted for
 * an install that never ran), sent to the runtime in one response as it starts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRANSFORM_VERSION, tmpSuffix } from './install.ts';
import { Prefetcher } from './prefetch.ts';
import { installer, devCacheRoot } from './installs.ts';
import { bundleHead } from '../../bundle-format.ts';
import { renameRetrying } from '../../rename-retrying.ts';

/**
 * Preloading: the installed files that runs load (node_modules/…, compiled or raw), recorded as the
 * host serves them, in the order of first use. A later run fetches them as one bundle instead of
 * one synchronous request each, which dominates start-up (next dev loads ~1,700 files). They are
 * recorded per install and per package version, so an install that was never run still gets a
 * bundle for the packages other installs loaded (a new app with next@16 preloads Next.js).
 * Files over PRELOAD_FILE_MAX are left out: WebAssembly binaries (swc's is 30 MB), which the bundle
 * only names, for the runtime to download on the side. Large JavaScript is in (webpack's 2.6 MB
 * bundle5.js, Next.js' app-page runtime): each was a request of its own.
 */
const PRELOAD_FILE_MAX = 10 << 20;

const preloadLists = new Map<string, Map<string, true>>();

const preloadDirty = new Set<string>();

let preloadFlush: ReturnType<typeof setTimeout> | null = null;

const preloadListPath = (key: string) => join(devCacheRoot(), `preload-${key}.json`);

/** "name@version" → "mode:path-in-package" entries; one file for all packages. */
const PACKAGE_LIST = '_packages';

/** Package versions by install and package directory. */
const packageVersions = new Map<string, Promise<string | null>>();

/** When each list's file was last read or written by this process (its mtime), to tell another process's writes. */
const preloadSeen = new Map<string, number>();

async function savedPreloadList(key: string): Promise<string[]> {
  const file = preloadListPath(key);
  const mtime = (await stat(file).catch(() => null))?.mtimeMs;
  if (mtime === undefined) return [];
  preloadSeen.set(key, mtime);
  return readFile(file, 'utf8')
    .then((t) => JSON.parse(t) as unknown)
    .then((v) => (Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : []))
    .catch(() => [] as string[]);
}

export async function preloadList(key: string): Promise<Map<string, true>> {
  let list = preloadLists.get(key);
  if (!list) {
    const saved = await savedPreloadList(key);
    list = preloadLists.get(key) ?? new Map(saved.map((e) => [e, true] as const));
    preloadLists.set(key, list);
  }
  return list;
}

export function markDirty(key: string) {
  preloadDirty.add(key);
  preloadFlush ??= setTimeout(() => void flushPreloadLists(), 2000);
}

/** Writes the preload lists recorded since the last write. Called from a timer: a failure only loses what the next run would have preloaded. */
async function flushPreloadLists(): Promise<void> {
  preloadFlush = null;
  if (!(await mkdir(devCacheRoot(), { recursive: true }).then(() => true, () => false))) return;
  for (const k of [...preloadDirty]) {
    preloadDirty.delete(k);
    const file = preloadListPath(k);
    const list = preloadLists.get(k);
    if (!list) continue;
    // Another process on the same .sandburg/ may have written the list since: its entries are
    // kept (after this process's), not overwritten. On Windows the rename waits out a reader of
    // the list (another process's) rather than losing this process's entries.
    if ((await stat(file).catch(() => null))?.mtimeMs !== preloadSeen.get(k)) for (const e of await savedPreloadList(k)) list.set(e, true);
    const tmp = `${file}.${tmpSuffix()}.tmp`;
    await writeFile(tmp, JSON.stringify([...list.keys()]))
      .then(() => renameRetrying(tmp, file))
      .then(() => stat(file))
      .then((st) => preloadSeen.set(k, st.mtimeMs))
      .catch(() => {});
  }
}

/** The package a path is in: its directory ("…/node_modules/@scope/name"), name and the path inside it. */
function packageOf(rel: string): { dir: string; name: string; inner: string } | null {
  const at = rel.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const parts = rel.slice(at + 'node_modules/'.length).split('/');
  const n = parts[0].startsWith('@') ? 2 : 1;
  if (parts.length <= n) return null;
  const name = parts.slice(0, n).join('/');
  return { dir: `${rel.slice(0, at)}node_modules/${name}`, name, inner: parts.slice(n).join('/') };
}

function packageVersion(key: string, dir: string): Promise<string | null> {
  let v = packageVersions.get(`${key}\0${dir}`);
  if (!v) {
    v = installer
      .raw(key, `${dir}/package.json`)
      .then((f) => (f ? ((JSON.parse(f.body.toString('utf8')) as { version?: string } | null)?.version ?? null) : null))
      .catch(() => null);
    packageVersions.set(`${key}\0${dir}`, v);
  }
  return v;
}

export async function recordLoad(key: string, mode: string, rel: string): Promise<void> {
  const list = await preloadList(key);
  if (list.has(`${mode}:${rel}`)) return;
  list.set(`${mode}:${rel}`, true);
  markDirty(key);
  const pkg = packageOf(rel);
  const version = pkg && (await packageVersion(key, pkg.dir));
  if (!pkg || !version) return;
  const packages = await preloadList(PACKAGE_LIST);
  const entry = `${pkg.name}@${version}\0${mode}:${pkg.inner}`;
  if (packages.has(entry)) return;
  packages.set(entry, true);
  markDirty(PACKAGE_LIST);
}

/**
 * The files of an install that its runs read, by "mode:path": loaded one by one, or read from a
 * preload bundle (the runtime tells the host, see noteRead in node-runtime/host-files.ts). A
 * bundle holds every file runs ever loaded, and what was predicted for a first run (prefetch.ts):
 * a warm next-app-router run read 16 of its 43 MB, and the browser's transfer of a bundle (~150-250
 * MB/s here) is most of a warm run's start. Once runs have said what they read, bundles hold that.
 */
export const readList = (key: string) => preloadList(`${key}-read`);

/**
 * The files to preload for an install: those its runs loaded, then those that runs of other installs
 * loaded from the same package versions, where this install has them. Once its runs have said what
 * they read (markRead), only that: in the order they were loaded, then those read from a bundle that
 * this install's runs never asked for one by one (borrowed from another install's list).
 */
export async function preloadEntries(key: string): Promise<string[]> {
  const read = await readList(key);
  if (read.size) {
    const own = await preloadList(key);
    return [...own.keys()].filter((e) => read.has(e)).concat([...read.keys()].filter((e) => !own.has(e)));
  }
  const own = [...(await preloadList(key)).keys()];
  const byPackage = new Map<string, string[]>();
  for (const e of (await preloadList(PACKAGE_LIST)).keys()) {
    const [pkg, entry] = e.split('\0');
    const entries = byPackage.get(pkg);
    if (entries) entries.push(entry);
    else byPackage.set(pkg, [entry]);
  }
  const recorded = new Set([...byPackage.keys()].map((p) => p.slice(0, p.lastIndexOf('@'))));
  const index = await installer.index(key);
  const seen = new Set(own);
  const out = [...own];
  for (const path of Object.keys(index)) {
    if (!path.endsWith('/package.json')) continue;
    const pkg = packageOf(path);
    if (!pkg || pkg.inner !== 'package.json') continue;
    if (!recorded.has(pkg.name)) continue;
    const version = await packageVersion(key, pkg.dir);
    const entries = version ? byPackage.get(`${pkg.name}@${version}`) : undefined;
    for (const entry of entries ?? []) {
      const full = `${entry.slice(0, 2)}${pkg.dir}/${entry.slice(2)}`;
      if (!seen.has(full) && full.slice(2) in index) {
        seen.add(full);
        out.push(full);
      }
    }
  }
  return out;
}

/** The file lists of the bundles handed out, by hash: fixed when the URL is (the lists grow as the run loads files). */
const issuedBundles = new Map<string, string[]>();

/**
 * Installs never run: what their programs require is found and transformed ahead, from the
 * program's entry and from the files its runtimes ask for (see prefetch.ts), and their first bundle
 * is what that found (predictedBundle).
 */
export const prefetchers = new Map<string, Promise<Prefetcher>>();

/** Builds a predicted bundle, by install and hash, until it is first asked for (then it is kept as the others are, in `bundles`). */
const predicted = new Map<string, () => Promise<Buffer>>();

/** The preload bundle's URL for an install, or null when there is nothing to preload. */
export async function preloadUrl(key: string, start: { main?: string; require?: string }): Promise<string | null> {
  const entries = await preloadEntries(key);
  if (!(await preloadList(key)).size) {
    let p = prefetchers.get(key);
    if (!p) {
      p = installer.index(key).then((index) => new Prefetcher(installer, key, index));
      prefetchers.set(key, p);
    }
    const prefetcher = await p;
    // The program's first modules are transformed while the page starts it.
    if (start.main) prefetcher.add(start.main);
    if (start.require) await prefetcher.require(start.require);
    const hash = randomBytes(8).toString('hex');
    predicted.set(`${key}/${hash}`, () => predictedBundle(key, entries, prefetcher));
    return `/__sandburg/preload/${key}/${hash}`;
  }
  // Run before: it preloads what its runs loaded.
  prefetchers.delete(key);
  if (!entries.length) return null;
  const hash = createHash('sha256').update(`${TRANSFORM_VERSION}\0${PRELOAD_FILE_MAX}\0side\0`).update(entries.join('\n')).digest('hex').slice(0, 16);
  issuedBundles.set(`${key}/${hash}`, entries);
  // Built now, while the run's page and runtime start: a new bundle (the lists grew) took ~1.8 s to
  // build for next dev, and the runtime asks for it synchronously with its first installed file.
  void preloadBundle(key, hash);
  return `/__sandburg/preload/${key}/${hash}`;
}

/**
 * The latest bundles, built or being built, of the installs used last (every runtime of a run asks
 * for its install's; tens of MB each, so only a few are kept).
 */
const bundles = new Map<string, { hash: string; bundle: Promise<Buffer | null> }>();

export const BUNDLES_KEPT = 4;

/**
 * What this process keeps of an install found removed (Installer.install), which may be made again
 * with other files: its lists are read again from their files, its bundles built again. The package
 * versions' list is read again too if its file is gone (.sandburg cleared).
 */
installer.onForget((key) => {
  for (const name of [key, `${key}-read`]) {
    preloadLists.delete(name);
    preloadSeen.delete(name);
    preloadDirty.delete(name);
  }
  for (const id of packageVersions.keys()) if (id.startsWith(`${key}\0`)) packageVersions.delete(id);
  for (const map of [issuedBundles, predicted]) for (const id of map.keys()) if (id.startsWith(`${key}/`)) map.delete(id);
  prefetchers.delete(key);
  bundles.delete(key);
  if (preloadSeen.has(PACKAGE_LIST) && !preloadDirty.has(PACKAGE_LIST)) {
    void stat(preloadListPath(PACKAGE_LIST)).catch(() => {
      if (preloadDirty.has(PACKAGE_LIST)) return;
      preloadLists.delete(PACKAGE_LIST);
      preloadSeen.delete(PACKAGE_LIST);
    });
  }
});

export function preloadBundle(key: string, hash: string): Promise<Buffer | null> {
  const known = bundles.get(key);
  if (known?.hash === hash) return known.bundle;
  // A never-run install's predicted bundle is built when it is first asked for (predictedBundle).
  const id = `${key}/${hash}`;
  const guessed = predicted.get(id);
  predicted.delete(id);
  const bundle = guessed
    ? guessed().catch(() => (predicted.set(id, guessed), null))
    : buildPreloadBundle(key, hash).catch(() => null);
  bundles.delete(key);
  bundles.set(key, { hash, bundle });
  for (const old of bundles.keys()) if (bundles.size > BUNDLES_KEPT) bundles.delete(old);
  // A failed build is tried again by the next request.
  void bundle.then((b) => {
    if (!b && bundles.get(key)?.bundle === bundle) bundles.delete(key);
  });
  return bundle;
}

/**
 * A never-run install's bundle: the files other installs' runs loaded from its package versions
 * (`known`), and what its prefetcher found by the time the bundle is asked for and PREDICT_WAIT
 * after (or when it has found everything). The runtime waits for its bundle; what the bundle misses
 * it asks for one by one, and the prefetcher keeps transforming ahead. The files are recorded as
 * loaded, as if each had been asked for: later runs preload them from the install's list and the
 * package lists, as they do the files runs asked for, from a bundle that is kept.
 */
async function predictedBundle(key: string, known: string[], prefetcher: Prefetcher): Promise<Buffer> {
  await prefetcher.untilIdle(PREDICT_WAIT);
  const entries = [...new Set([...known, ...prefetcher.transformed.map((rel) => `t:${rel}`), ...[...prefetcher.raw].map((rel) => `f:${rel}`)])];
  const bundle = await buildBundle(key, entries);
  void (async () => {
    for (const [mode, rel] of bundle.files) await recordLoad(key, mode, rel);
  })();
  return bundle.body;
}

const PREDICT_WAIT = 8000;

/** A bundle of `entries` ("mode:path"), and the files in it (raw files over PRELOAD_FILE_MAX are only named, for the runtime to download on the side). */
async function buildBundle(key: string, entries: string[]): Promise<{ body: Buffer; files: [string, string][] }> {
  const header: [string, string, number][] = [];
  const bodies: Buffer[] = [];
  const index = await installer.index(key);
  for (const entry of entries) {
    const mode = entry[0];
    const rel = entry.slice(2);
    // A large raw file (a WebAssembly binary) is named with its size negated, for the runtime to
    // download on the side as soon as it has the bundle, before the program asks for it.
    if (mode === 'f' && (index[rel] ?? 0) > PRELOAD_FILE_MAX) {
      header.push([mode, rel, -index[rel]]);
      continue;
    }
    const got = mode === 't' ? await installer.file(key, rel) : await installer.raw(key, rel);
    if (!got || got.body.length > PRELOAD_FILE_MAX) continue;
    header.push([mode, rel, got.body.length]);
    bodies.push(got.body);
  }
  return { body: Buffer.concat([bundleHead(header), ...bodies]), files: header.map(([mode, rel]) => [mode, rel]) };
}

/**
 * The bundle: a little-endian u32 header length, a JSON header [[mode, path, length], …], then the
 * files' bytes in that order (mode "t": compiled for the runtime, "f": raw).
 */
async function buildPreloadBundle(key: string, hash: string): Promise<Buffer | null> {
  const file = join(devCacheRoot(), `preload-${key}-${hash}.bin`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return cached;
  const entries = issuedBundles.get(`${key}/${hash}`);
  if (!entries) return null;
  const bundle = (await buildBundle(key, entries)).body;
  await mkdir(devCacheRoot(), { recursive: true });
  // Earlier bundles of the install (the lists grew since) are not asked for again.
  for (const old of await readdir(devCacheRoot()).catch(() => [] as string[])) {
    if (old.startsWith(`preload-${key}-`) && old.endsWith('.bin')) await rm(join(devCacheRoot(), old), { force: true });
  }
  const tmp = `${file}.${tmpSuffix()}.tmp`;
  await writeFile(tmp, bundle);
  await renameRetrying(tmp, file);
  return bundle;
}
