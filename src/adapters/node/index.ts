/**
 * node runtime adapter (Node half): Sandburg's own Node.js runtime for the
 * browser (ADR 0006). Dependencies are installed on the host with npm
 * (--ignore-scripts: no package code runs outside the browser) and served
 * lazily; the app itself, Next.js included, runs in a Web Worker.
 */
import { source } from '../../sources.ts';
import { bundleNodeRuntime, bundleSqlite, SQLITE_WASM } from '../../node-runtime/bundle.ts';
import { bundleBrowserCompiler, COMPILE_WORKER, ESBUILD_WASM } from './compile-wasm-bundle.ts';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findFullStack } from './scripts.ts';
import { projectFromFiles } from '../../project.ts';
import { browserInstall, devScript, isSimple, packageDirs, startCommand, staticInstall, subProject } from './plan.ts';
import { NODE_VERSION } from '../../node-runtime/version.ts';
import type { AdapterDescriptor, HostInstallOptions, HostRequest, HostResponse, Project } from '../../types.ts';
import { compileForRuntime, projectHasTopLevelAwait, type CompileKind } from './compile.ts';
import { TRANSFORM_VERSION, sharedInstaller, tmpSuffix } from './install.ts';
import type { HostInstall } from './browser.ts';
import { VITE_SEED_DIRS, VITE_SEED_WAIT, viteSeed } from './vite-seed.ts';
import { warmups } from './warmup.ts';
import { extraDependencies } from './install-rules.ts';

const installer = sharedInstaller();
const WS_SHIM = source('adapters/node/ws-shim.js');

/**
 * Dev servers' dependency caches, kept between runs: Vite's pre-bundled dependencies
 * (node_modules/.vite/deps of each package). Vite checks that a cache matches the lockfile and its
 * config before it uses one, so a stale cache costs a re-optimization, not a wrong result. A run
 * writes its cache from the page, which runs the project's code, so a cache is only ever used by
 * runs of the same project (its installed packages and every file): one project cannot plant
 * pre-bundled code in another's run.
 */
const DEV_CACHE_DIRS = ['node_modules/.vite/deps'];
const devCacheRoot = () => join(installer.root, '..', 'dev-cache');

function devCacheKey(project: Project, installKey: string): string {
  const h = createHash('sha256').update(installKey);
  for (const path of Object.keys(project.files).sort()) {
    const content = project.files[path];
    h.update(path).update('\0').update(typeof content === 'string' ? content : JSON.stringify(content)).update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

/**
 * Cache keys issued to runs, with the directories their caches may hold. A run can only store a
 * cache under a key it was given, and only files under those directories (the page can reach the
 * endpoint, so what it sends is untrusted).
 */
const issuedCaches = new Map<string, string[]>();
const DEV_CACHE_MAX = 256 << 20;

/** The entries of a cache that are text files under `dirs`. */
function cacheEntries(value: unknown, dirs: string[]): Record<string, string | { base64: string }> {
  const out: Record<string, string | { base64: string }> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [path, content] of Object.entries(value)) {
    // Text, or binary as { base64 } (webpack's cache packs).
    const file = typeof content === 'string' || (!!content && typeof content === 'object' && Object.keys(content).length === 1 && typeof (content as { base64?: unknown }).base64 === 'string');
    if (!file || path.split('/').includes('..')) continue;
    if (dirs.some((d) => path.startsWith(`${d}/`))) out[path] = content;
  }
  return out;
}

async function readDevCache(key: string, dirs: string[]): Promise<Record<string, string | { base64: string }>> {
  try {
    return cacheEntries(JSON.parse(await readFile(join(devCacheRoot(), `${key}.json`), 'utf8')), dirs);
  } catch {
    return {};
  }
}

/** Caches handed to runs to start from, and the directories they may hold (see cacheBundle). */
const readableCaches = new Map<string, string[]>();

/**
 * A stored cache as a bundle (the preload format: u32 header length, JSON [[mode, path, length], …],
 * bytes): the worker fetches it itself, instead of tens of megabytes of base64 in the install data.
 */
async function cacheBundle(key: string): Promise<Buffer | null> {
  const dirs = readableCaches.get(key);
  if (!dirs) return null;
  const json = join(devCacheRoot(), `${key}.json`);
  const bin = `${json}.bin`;
  const [jsonStat, binStat] = await Promise.all([stat(json).catch(() => null), stat(bin).catch(() => null)]);
  if (!jsonStat) return null;
  if (binStat && binStat.mtimeMs >= jsonStat.mtimeMs) return readFile(bin);
  const header: [string, string, number][] = [];
  const bodies: Buffer[] = [];
  for (const [path, content] of Object.entries(await readDevCache(key, dirs))) {
    const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content.base64, 'base64');
    header.push(['f', path, body.length]);
    bodies.push(body);
  }
  const head = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(head.length);
  const bundle = Buffer.concat([length, head, ...bodies]);
  const tmp = `${bin}.${tmpSuffix()}.tmp`;
  await writeFile(tmp, bundle);
  await rename(tmp, bin);
  return bundle;
}

/**
 * Seed keys (Next.js and Vite seeds) issued to a seed run and not yet written. A seed's key is shared:
 * later runs learn it (their filesBundle URL), and the host cannot tell runs apart. So a seed key
 * takes one write, the seed run's own, and is withdrawn before it (restored if the write fails).
 */
const pendingSeeds = new Set<string>();

async function writeDevCache(key: string, body: Buffer): Promise<boolean> {
  const dirs = issuedCaches.get(key);
  if (!dirs || body.length > DEV_CACHE_MAX) return false;
  const seed = pendingSeeds.delete(key);
  if (seed) issuedCaches.delete(key);
  try {
    const files = cacheEntries(JSON.parse(body.toString('utf8')), dirs);
    await mkdir(devCacheRoot(), { recursive: true });
    const file = join(devCacheRoot(), `${key}.json`);
    const tmp = `${file}.${tmpSuffix()}.tmp`;
    await writeFile(tmp, JSON.stringify(files));
    await rename(tmp, file);
    return true;
  } catch {
    if (seed) {
      pendingSeeds.add(key);
      issuedCaches.set(key, dirs);
    }
    return false;
  }
}

/**
 * Preloading: the installed files that runs load (node_modules/…, compiled or raw), recorded as the
 * host serves them, in the order of first use. A later run fetches them as one bundle instead of
 * one synchronous request each, which dominates start-up (next dev loads ~1,700 files). They are
 * recorded per install and per package version, so an install that was never run still gets a
 * bundle for the packages other installs loaded (a new app with next@16 preloads Next.js).
 * Files over PRELOAD_FILE_MAX are left out (a few large ones, WebAssembly binaries).
 */
const PRELOAD_FILE_MAX = 2 << 20;
const preloadLists = new Map<string, Map<string, true>>();
const preloadDirty = new Set<string>();
let preloadFlush: ReturnType<typeof setTimeout> | null = null;
const preloadListPath = (key: string) => join(devCacheRoot(), `preload-${key}.json`);
/** "name@version" → "mode:path-in-package" entries; one file for all packages. */
const PACKAGE_LIST = '_packages';
/** Package versions by install and package directory. */
const packageVersions = new Map<string, Promise<string | null>>();

async function preloadList(key: string): Promise<Map<string, true>> {
  let list = preloadLists.get(key);
  if (!list) {
    const saved = await readFile(preloadListPath(key), 'utf8').then((t) => JSON.parse(t) as string[], () => [] as string[]);
    list = preloadLists.get(key) ?? new Map(saved.map((e) => [e, true] as const));
    preloadLists.set(key, list);
  }
  return list;
}

function markDirty(key: string) {
  preloadDirty.add(key);
  preloadFlush ??= setTimeout(async () => {
    preloadFlush = null;
    await mkdir(devCacheRoot(), { recursive: true });
    for (const k of [...preloadDirty]) {
      preloadDirty.delete(k);
      const file = preloadListPath(k);
      const tmp = `${file}.${tmpSuffix()}.tmp`;
      await writeFile(tmp, JSON.stringify([...(preloadLists.get(k)?.keys() ?? [])]))
        .then(() => rename(tmp, file))
        .catch(() => {});
    }
  }, 2000);
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
    v = installer.raw(key, `${dir}/package.json`).then(
      (f) => (f ? ((JSON.parse(f.body.toString('utf8')) as { version?: string }).version ?? null) : null),
      () => null,
    );
    packageVersions.set(`${key}\0${dir}`, v);
  }
  return v;
}

async function recordLoad(key: string, mode: string, rel: string): Promise<void> {
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
 * The files to preload for an install: those its runs loaded, then those that runs of other installs
 * loaded from the same package versions, where this install has them.
 */
async function preloadEntries(key: string): Promise<string[]> {
  const own = [...(await preloadList(key)).keys()];
  const byPackage = new Map<string, string[]>();
  for (const e of (await preloadList(PACKAGE_LIST)).keys()) {
    const [pkg, entry] = e.split('\0');
    byPackage.get(pkg)?.push(entry) ?? byPackage.set(pkg, [entry]);
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

/** The preload bundle's URL for an install, or null when there is nothing to preload yet. */
async function preloadUrl(key: string): Promise<string | null> {
  const entries = await preloadEntries(key);
  if (!entries.length) return null;
  const hash = createHash('sha256').update(`${TRANSFORM_VERSION}\0`).update(entries.join('\n')).digest('hex').slice(0, 16);
  issuedBundles.set(`${key}/${hash}`, entries);
  return `/__sandburg/preload/${key}/${hash}`;
}

/**
 * The bundle: a little-endian u32 header length, a JSON header [[mode, path, length], …], then the
 * files' bytes in that order (mode "t": compiled for the runtime, "f": raw).
 */
async function preloadBundle(key: string, hash: string): Promise<Buffer | null> {
  const file = join(devCacheRoot(), `preload-${key}-${hash}.bin`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return cached;
  const entries = issuedBundles.get(`${key}/${hash}`);
  if (!entries) return null;
  const header: [string, string, number][] = [];
  const bodies: Buffer[] = [];
  for (const entry of entries) {
    const mode = entry[0];
    const rel = entry.slice(2);
    const got = mode === 't' ? await installer.file(key, rel) : await installer.raw(key, rel);
    if (!got || got.body.length > PRELOAD_FILE_MAX) continue;
    header.push([mode, rel, got.body.length]);
    bodies.push(got.body);
  }
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  const bundle = Buffer.concat([length, json, ...bodies]);
  await mkdir(devCacheRoot(), { recursive: true });
  // Earlier bundles of the install (the lists grew since) are not asked for again.
  for (const old of await readdir(devCacheRoot()).catch(() => [] as string[])) {
    if (old.startsWith(`preload-${key}-`) && old.endsWith('.bin')) await rm(join(devCacheRoot(), old), { force: true });
  }
  const tmp = `${file}.${tmpSuffix()}.tmp`;
  await writeFile(tmp, bundle);
  await rename(tmp, file);
  return bundle;
}

/**
 * Next.js' webpack cache, seeded per version (ADR 0014). In an app's first compile, almost every
 * module is the framework's (React, Next.js' client and server runtimes), the same in every app with
 * the same versions. For each set of versions, the session runs Sandburg's own seed app once; the
 * webpack cache it leaves (.next/cache, with the key Next.js derives the cache version from) is where
 * every later app with those versions starts. Webpack still checks each cached module against its
 * files, so the app's own modules are compiled; a different next.config gives a different cache
 * version, and webpack starts empty. The seed is the session's, never a project's: a project cannot
 * write a cache that another project's run starts from.
 */
const NEXT_SEED_DIRS = ['.next/cache'];
const seeding = new Map<string, Promise<void>>();

function nextSeedKey(versions: Record<string, string>): string {
  return createHash('sha256').update(`next-seed\0${JSON.stringify(versions)}\0${NODE_VERSION}\0${TRANSFORM_VERSION}`).digest('hex').slice(0, 24);
}

function nextSeedProject(versions: Record<string, string>): { project: Project; checks: Record<string, (ctx: { app: { goto?: unknown }; page: { evaluate(f: () => Promise<unknown>): Promise<unknown> } }) => Promise<void>> } {
  const files = {
    'package.json': JSON.stringify({ name: 'sandburg-next-seed', private: true, scripts: { dev: 'next dev' }, dependencies: versions }, null, 2),
    'app/layout.js': `export const metadata = { title: 'Seed' };\nexport default function RootLayout({ children }) {\n  return (<html lang="en"><body>{children}</body></html>);\n}\n`,
    'app/page.js': `import Counter from './counter';\nimport Link from 'next/link';\nexport default function Page() {\n  return (<main><h1>Seed</h1><Counter /><Link href="/about">About</Link></main>);\n}\n`,
    'app/counter.js': `'use client';\nimport { useState } from 'react';\nexport default function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>Count {n}</button>;\n}\n`,
    'app/about/page.js': `export default function About() {\n  return <p>About</p>;\n}\n`,
    'app/api/ping/route.js': `export async function GET() {\n  return Response.json({ ok: true });\n}\n`,
  };
  const project = projectFromFiles(files, { name: `sandburg-next-seed@${versions.next}`, path: `sandburg:next-seed/${versions.next}` });
  // Compile what apps compile first: a page with a client component, another route, a route handler.
  const checks = {
    'the page, a route and a route handler compile': async ({ app }: { app: { getByRole(r: string, o: object): { click(): Promise<void> }; evaluate(f: () => Promise<unknown>): Promise<unknown> } }) => {
      await app.getByRole('button', { name: /Count/ }).click();
      await app.evaluate(() => fetch('/api/ping').then((r) => r.json()));
      await app.getByRole('link', { name: 'About' }).click();
    },
  };
  return { project, checks: checks as never };
}

/**
 * The key of the Vite seed for an app (see vite-seed.ts), and whether its cache exists. A key's
 * second app starts its seed run; apps never wait for one.
 */
async function viteSeedCache(project: Project, installKey: string, options: HostInstallOptions | undefined, log: (line: string) => void): Promise<{ key: string; ready: boolean } | null> {
  const seed = viteSeed(project, installKey, `${NODE_VERSION}\0${TRANSFORM_VERSION}`);
  if (!seed) return null;
  const stored = () => stat(join(devCacheRoot(), `${seed.key}.json`)).then(() => true, () => false);
  if (options?.seed) return { key: seed.key, ready: false };
  // Seeded when a second app with this key comes: most keys belong to one app, which would pay for
  // a seed run it gains nothing from. The first app pre-bundles on its own, as without seeds.
  const seen = join(devCacheRoot(), `vite-seen-${seed.key}`);
  if (!(await stored()) && !(await stat(seen).then(() => true, () => false))) {
    await mkdir(devCacheRoot(), { recursive: true });
    await writeFile(seen, '');
    return { key: seed.key, ready: false };
  }
  if (await stored()) return { key: seed.key, ready: true };
  // Made beside the app, which does not wait for it: an app pre-bundles its packages in about the
  // time a seed run takes, so waiting would only gain for large packages. Later apps use the seed.
  if (options?.runSeed && !seeding.has(seed.key)) {
    log(`pre-bundling the app's packages in a seed run, for later apps with the same packages and config`);
    seeding.set(seed.key, options.runSeed(seed.project, {}).catch((e: Error) => log(`seeding failed: ${e.message}`)));
  }
  return { key: seed.key, ready: false };
}

/** The key of the Next.js seed cache for an install's versions, and whether it exists (seeding it first if needed). */
async function nextSeedCache(resolved: Record<string, string>, options: HostInstallOptions | undefined, log: (line: string) => void): Promise<{ key: string; ready: boolean } | null> {
  const versions = { next: resolved.next, react: resolved.react, 'react-dom': resolved['react-dom'] };
  if (!versions.next || !versions.react || !versions['react-dom']) return null;
  const key = nextSeedKey(versions);
  const stored = () => stat(join(devCacheRoot(), `${key}.json`)).then(() => true, () => false);
  if (options?.seed) return { key, ready: false };
  if (!(await stored()) && options?.runSeed) {
    let pending = seeding.get(key);
    if (!pending) {
      log(`seeding the webpack cache for next@${versions.next} (once per set of versions)`);
      const seed = nextSeedProject(versions);
      pending = options.runSeed(seed.project, seed.checks).catch((e: Error) => log(`seeding failed: ${e.message}`));
      seeding.set(key, pending);
    }
    await pending;
  }
  return { key, ready: await stored() };
}

/** The JS file behind a package binary (node_modules/.bin/<name>), from the installed packages' "bin" fields. */
async function resolveBin(installDir: string, name: string): Promise<string | null> {
  const nm = join(installDir, 'node_modules');
  const candidates = [name, ...(await readdir(nm).catch(() => [] as string[]))];
  for (const dir of candidates) {
    const pkgs = dir.startsWith('@') ? (await readdir(join(nm, dir)).catch(() => [] as string[])).map((s) => `${dir}/${s}`) : [dir];
    for (const pkgName of pkgs) {
      try {
        const pkg = JSON.parse(await readFile(join(nm, pkgName, 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> };
        const bin = typeof pkg.bin === 'string' ? (pkg.name?.split('/').pop() === name ? pkg.bin : null) : pkg.bin?.[name];
        if (bin) return `node_modules/${pkgName}/${bin.replace(/^\.\//, '')}`;
      } catch {
        // not a package
      }
    }
  }
  return null;
}

export async function serve(req: HostRequest): Promise<HostResponse | null> {
  if (req.path === '/__sandburg/node-worker.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await bundleNodeRuntime() };
  }
  // The page's compiler, when the page installs the packages (compile-worker.ts).
  if (req.path === '/__sandburg/compile-worker.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await bundleBrowserCompiler(COMPILE_WORKER) };
  }
  if (req.path === '/__sandburg/esbuild.wasm') {
    return { status: 200, headers: { 'content-type': 'application/wasm', 'cache-control': 'max-age=31536000, immutable' }, body: await readFile(ESBUILD_WASM) };
  }
  if (req.path === '/__sandburg/ws-shim.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await readFile(WS_SHIM) };
  }
  if (req.path === '/__sandburg/sqlite3.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await bundleSqlite() };
  }
  if (req.path === '/__sandburg/sqlite3.wasm') {
    return { status: 200, headers: { 'content-type': 'application/wasm', 'cache-control': 'max-age=31536000, immutable' }, body: await readFile(SQLITE_WASM) };
  }
  if (req.path === '/__sandburg/tla-scan' && req.method === 'POST') {
    const files = JSON.parse((await req.body()).toString('utf8')) as Record<string, string>;
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topLevelAwait: projectHasTopLevelAwait(files) }) };
  }
  if (req.path === '/__sandburg/compile' && req.method === 'POST') {
    const kind = (req.query.get('kind') ?? 'cjs') as CompileKind;
    try {
      return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: compileForRuntime((await req.body()).toString('utf8'), req.query.get('path') ?? '/unknown.js', kind, { asyncModules: req.query.get('async') === '1' }) };
    } catch (e) {
      return { status: 400, headers: { 'content-type': 'text/plain' }, body: String((e as Error).message) };
    }
  }
  // The dev servers' caches of a finished run (see DEV_CACHE_DIRS): project-relative path → text.
  const bundled = /^\/__sandburg\/dev-cache\/([0-9a-f]{24})\/bundle$/.exec(req.path);
  if (bundled) {
    const bundle = await cacheBundle(bundled[1]);
    return bundle ? { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: bundle } : null;
  }
  const cache = /^\/__sandburg\/dev-cache\/([0-9a-f]{24})$/.exec(req.path);
  if (cache && req.method === 'POST') {
    const saved = await writeDevCache(cache[1], await req.body());
    return saved ? { status: 200, headers: { 'content-type': 'text/plain' }, body: 'saved' } : { status: 403, headers: { 'content-type': 'text/plain' }, body: 'not a cache of this run' };
  }
  const pre = /^\/__sandburg\/preload\/([0-9a-f]{24})\/([0-9a-f]{16})$/.exec(req.path);
  if (pre) {
    const bundle = await preloadBundle(pre[1], pre[2]);
    return bundle ? { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' }, body: bundle } : null;
  }
  const m = /^\/__sandburg\/nm\/([0-9a-f]{24})\/(f|t)\/(.+)$/.exec(req.path);
  if (m) {
    const [, key, mode, rel] = m;
    const file = mode === 't' ? await installer.file(key, decodeURIComponent(rel)) : await installer.raw(key, decodeURIComponent(rel));
    if (file && file.body.length <= PRELOAD_FILE_MAX) void recordLoad(key, mode, decodeURIComponent(rel));
    return file ? { status: 200, headers: { 'content-type': file.type, 'cache-control': 'max-age=31536000, immutable' }, body: file.body } : null;
  }
  return null;
}

export const node: AdapterDescriptor = {
  name: 'node',
  version: NODE_VERSION,
  browserEntry: source('adapters/node/browser.ts'),
  assets: { '/__sw__.js': source('adapters/node/sw.js') },
  // The app's own server-side fetches (e.g. next/font/google) go through the gateway.
  // The npm registry: dev servers check it for newer versions of themselves (next dev does, on every start).
  egress: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://registry.npmjs.org'],
  // WebAssembly threads (rolldown and other Rust tools' WASI builds) need shared memory.
  crossOriginIsolation: 'credentialless',
  // A cold npm install of a Next.js app and its first webpack compile take a while.
  // expect: routes compile on first request (next dev), which is slower in the browser.
  // dispose: a seed run waits for webpack to store its cache (see nextSeedCache).
  timeouts: { install: 600_000, start: 180_000, ready: 240_000, check: 60_000, expect: 20_000, dispose: 60_000 },
  probe(project: Project) {
    if (project.framework === 'next' || project.framework === 'static') return { verdict: 'supported' };
    if (startCommand(project) || devScript(project)) return { verdict: 'supported' };
    const scripts = project.packageJson?.scripts ?? {};
    return { verdict: 'unsupported', reason: `no way to start this project in the node runtime (dev/start script: "${scripts.dev ?? scripts.start ?? ''}")` };
  },
  async hostInstall(project, log, options): Promise<HostInstall> {
    // A static site: no packages, a file server (see browser.ts).
    if (project.framework === 'static') return staticInstall();
    if (options?.installIn === 'browser') return browserInstall(project);
    const info = await installer.install(project, extraDependencies(project), log);
    // client/, server/ …: packages of their own that the dev script starts (or that the app imports from).
    const parts = [{ dir: '', key: info.key }];
    for (const dir of packageDirs(project)) {
      const sub = subProject(project, dir);
      const deps = sub.packageJson ? { ...sub.packageJson.dependencies, ...sub.packageJson.devDependencies } : {};
      if (!Object.keys(deps).length) continue;
      parts.push({ dir, key: (await installer.install(sub, {}, log)).key });
    }
    const key = parts.length > 1 ? installer.combine(parts) : info.key;
    let start: HostInstall['start'] = null;
    if (project.framework !== 'next') {
      const cmd = startCommand(project);
      const script = devScript(project);
      if (cmd && (!script || isSimple(project, script))) {
        const main = cmd.bin ? await resolveBin(info.dir, cmd.bin) : cmd.file;
        if (!main) throw new Error(`the dev script runs "${cmd.bin}", which no installed package provides`);
        start = { main, argv: cmd.argv, command: cmd.command, tsRunner: cmd.tsRunner };
      } else if (script) {
        start = { shell: script, command: script, tsRunner: false };
      }
    }
    const proxy = project.framework === 'next' ? [] : findFullStack(project.files).proxy;
    const cacheKey = devCacheKey(project, key);
    const cacheDirs = parts.flatMap((p) => DEV_CACHE_DIRS.map((d) => (p.dir ? `${p.dir}/${d}` : d)));
    issuedCaches.set(cacheKey, cacheDirs);
    let filesBundle: string | null = null;
    let devCache: NonNullable<HostInstall['devCache']> = { key: cacheKey, dirs: cacheDirs, files: await readDevCache(cacheKey, cacheDirs) };
    if (project.framework === 'next') {
      const seed = await nextSeedCache(info.resolved, options, log);
      if (seed && options?.seed) {
        // The seed run keeps its webpack cache under the shared key.
        issuedCaches.set(seed.key, NEXT_SEED_DIRS);
        pendingSeeds.add(seed.key);
        devCache = { key: seed.key, dirs: NEXT_SEED_DIRS, files: {}, waitFor: ['.next/cache/webpack/client-development/index.pack.gz', '.next/cache/webpack/server-development/index.pack.gz'] };
      } else if (seed?.ready) {
        readableCaches.set(seed.key, NEXT_SEED_DIRS);
        filesBundle = `/__sandburg/dev-cache/${seed.key}/bundle`;
      }
    }
    // A Vite app without a cache of its own starts from the seed for its packages and config.
    if (project.framework === 'vite' && parts.length === 1 && (options?.seed || !Object.keys(devCache.files).length)) {
      const seed = await viteSeedCache(project, info.key, options, log);
      if (seed && options?.seed) {
        issuedCaches.set(seed.key, VITE_SEED_DIRS);
        pendingSeeds.add(seed.key);
        devCache = { key: seed.key, dirs: VITE_SEED_DIRS, files: {}, waitFor: VITE_SEED_WAIT };
      } else if (seed?.ready) {
        readableCaches.set(seed.key, VITE_SEED_DIRS);
        filesBundle = `/__sandburg/dev-cache/${seed.key}/bundle`;
      }
    }
    return { key, index: await installer.index(key), resolved: info.resolved, lockfile: info.lockfile, start, proxy, devCache, filesBundle, preload: await preloadUrl(key) };
  },
  serve,
  warmups,
  isWarm: (project) => installer.installed(project, extraDependencies(project)),
};
