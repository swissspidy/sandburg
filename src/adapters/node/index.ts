/**
 * node runtime adapter (Node half): Sandburg's own Node.js runtime for the
 * browser (ADR 0006). Dependencies are installed on the host with npm
 * (--ignore-scripts: no package code runs outside the browser) and served
 * lazily; the app itself, Next.js included, runs in a Web Worker.
 */
import { source } from '../../sources.ts';
import { bundleNodeRuntime, bundleRuntimeLib, bundleSqlite, SPARE_SCRIPT, SQLITE_WASM } from '../../node-runtime/bundle.ts';
import { RUNTIME_LIBS, type RuntimeLib } from '../../node-runtime/libs.ts';
import { bundleBrowserCompiler, COMPILE_WORKER, ESBUILD_WASM } from './compile-wasm-bundle.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findFullStack } from './scripts.ts';
import { browserInstall, devScript, isSimple, packageDirs, startCommand, staticInstall, subProject } from './plan.ts';
import { NODE_VERSION } from '../../node-runtime/version.ts';
import type { AdapterDescriptor, HostRequest, HostResponse, Project } from '../../types.ts';
import { compiled, compileForRuntime, projectHasTopLevelAwait, storeCompiles, warmCompiler, type CompileKind } from './compile.ts';
import { TRANSFORM_VERSION } from './install.ts';
import { diskCompileStore, sweepCompiles } from './compile-store.ts';
import type { HostInstall } from './browser.ts';
import { VITE_SEED_DIRS, VITE_SEED_WAIT } from './vite-seed.ts';
import { warmups } from './warmup.ts';
import { extraDependencies } from './install-rules.ts';
import { installer } from './installs.ts';
import { DEV_CACHE_DIRS, devCacheKey, compileWrites, SOURCE_BODY_MAX, issueCacheWrite, issueCompileWrite, granted, readDevCache, cacheDigests, compileCache, compileKeys, readableCaches, cacheBundle, takeCacheWrite, writeDevCache } from './dev-cache.ts';
import { recordLoad, prefetchers, preloadUrl, preloadBundle } from './preload.ts';
import { readAhead, pushAhead } from './read-ahead.ts';
import { nextRouter, viteSeedCache, nextSeedCache } from './seeds.ts';

// Compiles of code the runtime sends, kept on disk as transforms are (compile-store.ts).
const compiledDir = join(installer.root, '..', 'compiled', `v${TRANSFORM_VERSION}`);
storeCompiles(diskCompileStore(compiledDir));
void sweepCompiles(compiledDir);
const WS_SHIM = source('adapters/node/ws-shim.js');

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
  // A spare runtime, which loads node-worker.js when it is used (threads.ts).
  if (req.path === '/__sandburg/node-spare.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: SPARE_SCRIPT };
  }
  // The polyfills a runtime loads when a program first needs them (RUNTIME_LIBS).
  const lib = /^\/__sandburg\/node-([a-z]+)\.js$/.exec(req.path);
  if (lib && Object.hasOwn(RUNTIME_LIBS, lib[1])) {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await bundleRuntimeLib(lib[1] as RuntimeLib) };
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
    const files = JSON.parse((await req.body(SOURCE_BODY_MAX)).toString('utf8')) as Record<string, string>;
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topLevelAwait: projectHasTopLevelAwait(files) }) };
  }
  // Code the runtime asks for by digest before it sends it (worker.ts): what was compiled before.
  const known = /^\/__sandburg\/compiled\/([0-9a-f]{64})$/.exec(req.path);
  if (known) {
    const out = compiled(known[1]);
    return out === undefined ? null : { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: out };
  }
  if (req.path === '/__sandburg/compile' && req.method === 'POST') {
    const kind = (req.query.get('kind') ?? 'cjs') as CompileKind;
    const code = (await req.body(SOURCE_BODY_MAX)).toString('utf8');
    try {
      const [path, async, key] = [req.query.get('path') ?? '/unknown.js', req.query.get('async') === '1', req.query.get('cache')];
      const out = compileForRuntime(code, path, kind, { asyncModules: async });
      if (key && granted(compileWrites, req.headers?.['x-sandburg-token'], key, req.sandbox)) void compileCache.record(key, kind, async, path, code, out);
      return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: out };
    } catch (e) {
      return { status: 400, headers: { 'content-type': 'text/plain' }, body: String((e as Error).message) };
    }
  }
  // What earlier runs of a project had compiled (see compile-cache.ts).
  const compiles = /^\/__sandburg\/compile-cache\/([0-9a-f]{24})$/.exec(req.path);
  if (compiles) {
    const bundle = compileKeys.has(compiles[1]) ? await compileCache.bundle(compiles[1]) : null;
    return bundle ? { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: bundle } : null;
  }
  // The dev servers' caches of a finished run (see DEV_CACHE_DIRS): project-relative path → text.
  const bundled = /^\/__sandburg\/dev-cache\/([0-9a-f]{24})\/bundle$/.exec(req.path);
  if (bundled) {
    const bundle = await cacheBundle(bundled[1]);
    return bundle ? { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: bundle } : null;
  }
  const cache = /^\/__sandburg\/dev-cache\/([0-9a-f]{24})$/.exec(req.path);
  if (cache && req.method === 'POST') {
    const grant = takeCacheWrite(cache[1], req.headers?.['x-sandburg-token'], req.sandbox);
    const saved = !!grant && (await writeDevCache(grant, req.body));
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
    // A file the runtime read from a read-ahead answer: recorded as loaded, as if it had been asked for.
    if (req.query.get('used') === '1') {
      if (decodeURIComponent(rel) in (await installer.index(key))) void recordLoad(key, mode, decodeURIComponent(rel));
      return { status: 204, headers: {}, body: '' };
    }
    const file = mode === 't' ? await installer.file(key, decodeURIComponent(rel)) : await installer.raw(key, decodeURIComponent(rel));
    if (file && mode === 'f' && req.query.get('ahead') === '1') {
      const body = await readAhead(key, decodeURIComponent(rel), file.body, req.query.get('until'));
      if (body) {
        void recordLoad(key, mode, decodeURIComponent(rel));
        return { status: 207, headers: { 'content-type': 'application/octet-stream' }, body };
      }
    }
    if (file && mode === 't' && req.channel && req.query.get('ahead') === '1') {
      const prefetcher = await prefetchers.get(key);
      const body = prefetcher ? pushAhead(key, decodeURIComponent(rel), file.body, prefetcher, req.channel) : null;
      if (body) {
        void recordLoad(key, mode, decodeURIComponent(rel));
        void prefetcher!.loaded(decodeURIComponent(rel), file.body.toString('utf8'));
        return { status: 207, headers: { 'content-type': 'application/octet-stream' }, body };
      }
    }
    if (file) void recordLoad(key, mode, decodeURIComponent(rel));
    if (file && mode === 't') void prefetchers.get(key)?.then((p) => p.loaded(decodeURIComponent(rel), file.body.toString('utf8')));
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
    // The runtime's bundle, which the page asks for as soon as the install is done, is built while npm runs.
    void bundleNodeRuntime().catch(() => {});
    for (const name of Object.keys(RUNTIME_LIBS) as RuntimeLib[]) void bundleRuntimeLib(name).catch(() => {});
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
    const compiles = {
      key: cacheKey,
      bundle: (await compileCache.has(cacheKey)) ? `/__sandburg/compile-cache/${cacheKey}` : null,
      token: issueCompileWrite(cacheKey, options?.sandbox),
    };
    let filesBundle: string | null = null;
    // The run's write of a cache: one, under one key, from its own sandbox.
    const write = (key: string, dirs: string[]) => issueCacheWrite(key, dirs, options?.sandbox);
    let devCache: NonNullable<HostInstall['devCache']> = { key: cacheKey, dirs: cacheDirs, files: await readDevCache(cacheKey, cacheDirs) };
    if (project.framework === 'next') {
      const seed = await nextSeedCache(info.resolved, nextRouter(project), options, log);
      if (seed && options?.seed) {
        // The seed run keeps its webpack cache under the shared key.
        devCache = { key: seed.key, dirs: seed.dirs, files: {}, token: write(seed.key, seed.dirs), waitFor: [`${seed.dirs[0]}/webpack/client-development/index.pack.gz`, `${seed.dirs[0]}/webpack/server-development/index.pack.gz`] };
      } else if (seed?.ready) {
        readableCaches.set(seed.key, seed.dirs);
        filesBundle = `/__sandburg/dev-cache/${seed.key}/bundle`;
      }
    }
    // A Vite app without a cache of its own starts from the seed for its packages and config.
    if (project.framework === 'vite' && parts.length === 1 && (options?.seed || !Object.keys(devCache.files).length)) {
      const seed = await viteSeedCache(project, info.key, options, log);
      if (seed && options?.seed) {
        devCache = { key: seed.key, dirs: VITE_SEED_DIRS, files: {}, token: write(seed.key, VITE_SEED_DIRS), waitFor: VITE_SEED_WAIT };
      } else if (seed?.ready) {
        readableCaches.set(seed.key, VITE_SEED_DIRS);
        filesBundle = `/__sandburg/dev-cache/${seed.key}/bundle`;
      }
    }
    // The app's own cache from an earlier run, as a bundle the runtime fetches: megabytes of base64 in
    // the install data took ~0.6 s to reach the runtime (SvelteKit's is 8 MB, the Angular CLI's 5 MB).
    // The page compares what the run leaves with the digests to tell whether to store it again.
    if (!filesBundle && devCache.key === cacheKey && Object.keys(devCache.files).length) {
      readableCaches.set(cacheKey, cacheDirs);
      filesBundle = `/__sandburg/dev-cache/${cacheKey}/bundle`;
      devCache = { ...devCache, files: {}, digests: cacheDigests(devCache.files) };
    }
    if (devCache.key === cacheKey) devCache.token = write(cacheKey, cacheDirs);
    // The program's entry, from which a never-run install's prefetch starts (see preloadUrl).
    const entry = start && 'main' in start ? { main: start.main } : project.framework === 'next' ? { require: 'next' } : {};
    return { key, index: await installer.index(key), resolved: info.resolved, lockfile: info.lockfile, start, proxy, devCache, filesBundle, compileCache: compiles, preload: await preloadUrl(key, entry) };
  },
  serve,
  warmups,
  isWarm: (project) => installer.installed(project, extraDependencies(project)),
  prepare: () => {
    installer.prepare();
    warmCompiler();
  },
};
