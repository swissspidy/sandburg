/**
 * Sandburg's Node.js runtime for the browser: runs in a dedicated Web Worker
 * (ADR 0006). The host page sends the project and an install key; the worker
 * serves node_modules lazily from the host, runs the entry script with a
 * Node-compatible module system and built-ins, and bridges HTTP requests for
 * virtual servers.
 */
import { Buffer } from 'buffer';
import { loadSqlite, type FileAccess } from './builtins/sqlite/core.ts';
import { WsClientCodec } from './websocket.ts';
import { bundleCache, listCache } from './cache-tree.ts';
import type { FromWorker, NetMessage, ToParent, ThreadInit, ToWorker, SharedPreload } from './messages.ts';
import { ThreadVfs, WASM_CRASH_CHANNEL, createWorkerThreads, liveRuntimes, trackNodeModulesWrites, warmRuntimes, type ThreadHost } from './threads.ts';
import { createChildProcess, nodeOptions } from './child-process.ts';
import { installNodeFetchClasses } from './fetch-classes.ts';
import { createBetterSqlite3 } from './builtins/sqlite/better-sqlite3.ts';
import { createSqlite3 } from './builtins/sqlite/sqlite3.ts';
import pathBrowserify from 'path-browserify';
import { installAsyncContext } from './async-context.ts';
import { adoptMailboxes, installNodeMessagePorts } from './message-ports.ts';
import { servers, serverEvents, type UpgradeSocket } from './builtins/http.ts';
import { initProcessTree, serversChanged } from './process-tree.ts';
import { ExitError, NODE_VERSION, createProcess, pendingWork, stopTimers, timers, timersActive } from './builtins/process.ts';
import { netEvents, netServers } from './builtins/net.ts';
import { createModuleSystem } from './loader.ts';
import { LIBS_KEY, type RuntimeLib } from './libs.ts';
import { Vfs } from './vfs.ts';
import { parseWorkspace, safeLinks, setLinks, WORKSPACE_FILE } from './links.ts';
import { TRANSFORM_CACHE, createTransformCache, type TransformCache } from './transform-cache.ts';
import { NATIVE_TRANSFORM, createNativeTransform } from './native-transform.ts';
import { CONFIG_BUNDLES, createConfigBundles } from './config-bundles.ts';
import { patchBase64Url, patchUtf8, patchHashCopy, patchBase64 } from './buffer-patches.ts';
import { COMPILE_POST_MAX } from '../file-channel.ts';
import { readBundle, prefetchedBody, bundleFiles, syncGet, compilesLoaded, loadCompiles, requestSync, startDigester, prepareDigester, dropPreparedDigester, shareChannel, useChannel, digestOf, digestWhenWritten, writtenDigest, ASK_FIRST, compileInPage, connectPageCompiler, installedFile, postViaChannel, postSync } from './host-files.ts';
import { buildBuiltins } from './builtins.ts';
import { compileAhead, compileWhenWritten, compiledAhead } from './compile-ahead.ts';
import { netConns, netMessage, nestedPorts, nestedSockets, loopbackReply, relayFromNested, forwardRequest, forgetNested, unannounce, loopbackServersGone } from './peers.ts';

patchBase64Url();

patchUtf8();

patchHashCopy();

patchBase64();

// Captured before any program runs: programs may assign globalThis.postMessage/onmessage (napi-rs's thread script does).
/** To the page, or to the runtime that started this one (a thread's or child process's parent). */
export const realPostMessage = (self as unknown as Worker).postMessage.bind(self) as (msg: ToParent, transfer?: Transferable[]) => void;
const realImportScripts = (self as unknown as { importScripts(url: string): void }).importScripts.bind(self);

/**
 * Web Worker globals that Node does not have. Programs see them as plain globals that start out
 * undefined, as in Node; some set them (napi-rs' WASI thread script assigns self, importScripts and
 * postMessage for emnapi), and every module then sees the assignment.
 */
function hideWorkerGlobals(): void {
  for (const name of ['self', 'location', 'importScripts']) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true, enumerable: false });
  }
}
export const post = (msg: FromWorker, transfer: Transferable[] = []) => realPostMessage(msg, transfer);

/**
 * A built-in's member that a runtime library has: an enumerable property that loads the library
 * when first read, then holds the library's value (a program may assign another, as in Node).
 */
export function lazyMember(target: Record<string, unknown>, key: string, lib: () => Record<string, unknown>): void {
  const own = (value: unknown) => Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get: () => {
      const value = lib()[key];
      own(value);
      return value;
    },
    set: own,
  });
}

/** A polyfill left out of the runtime's script (RUNTIME_LIBS in bundle.ts), loaded the first time it is needed. */
export function runtimeLib<T>(name: RuntimeLib): T {
  const libs = ((globalThis as Record<symbol, Record<string, unknown>>)[Symbol.for(LIBS_KEY)] ??= {});
  if (!(name in libs)) realImportScripts(`${base}/node-${name}.js`);
  return libs[name] as T;
}

installAsyncContext();

export let base = '/__sandburg';
export let installKey: string | null = null;
let projectRoot = '/app';

/**
 * Installed files come from the host one synchronous request each, or from the install's preload
 * bundle: once a runtime has asked for a few files, it fetches the bundle in one request (the browser
 * caches it for the other runtimes of the run). A program's runtime fetches it with its first file:
 * the bundle holds what runs of the install loaded, so a small program has a small one, and each
 * single request costs ~10-50 ms (next dev's first ten took ~0.2 s). A worker thread switches after
 * PRELOAD_AFTER_THREAD files, so the small WebAssembly helper threads never hold the bundle.
 */
export let preloadUrl: string | null = null;
export let preloaded: Map<string, Uint8Array> | null = null;

let preloadBytes: { bytes: Uint8Array; index: Record<string, [number, number]> } | null = null;
export let shared: SharedPreload | null = null;
let sharedBytes: Uint8Array | null = null;

function sharedPreload(): SharedPreload | null {
  if (shared || !preloadBytes) return shared;
  try {
    const whole = new Uint8Array(preloadBytes.bytes.buffer as ArrayBuffer);
    const sab = new SharedArrayBuffer(whole.length);
    new Uint8Array(sab).set(whole);
    shared = { sab, index: preloadBytes.index };
    sharedBytes = new Uint8Array(sab);
    // This runtime reads them there too (sharedFile is asked first), and lets go of its own copy.
    preloaded?.clear();
  } catch {
    // no shared memory: threads ask the host
  }
  preloadBytes = null;
  return shared;
}

/** Bundles the page is downloading for this runtime (see init.prefetched), by URL. */
export let prefetched: Record<string, SharedArrayBuffer> = {};

export function loadPreload(): void {
  preloaded = new Map();
  try {
    let bytes = prefetchedBody(preloadUrl!);
    if (!bytes) {
      const res = requestSync(preloadUrl!, true);
      if (res.status !== 200) return;
      bytes = res.body as Uint8Array;
    }
    const index: Record<string, [number, number]> = {};
    for (const [rel, file, mode] of bundleFiles(bytes)) {
      preloaded.set(`${mode}/${rel}`, file);
      index[`${mode}/${rel}`] = [file.byteOffset, file.length];
    }
    // Kept for threads and child processes only if this runtime has none to pass on; already in
    // shared memory if the page downloaded it.
    if (!shared && bytes.buffer instanceof SharedArrayBuffer) {
      shared = { sab: bytes.buffer, index };
      sharedBytes = new Uint8Array(bytes.buffer);
      preloaded.clear();
    } else if (!shared) preloadBytes = { bytes, index };
  } catch {
    // no bundle: files come one by one
  }
}

/** A file of the shared preload bundle (a copy: decoders do not read shared memory), or null. */
export function sharedFile(key: string): Uint8Array | null {
  const at = shared?.index[key];
  return at ? sharedBytes!.slice(at[0], at[0] + at[1]) : null;
}

/**
 * What the host compiled for earlier runs of the project (Vite's SSR modules, the project's own
 * files): fetched at the first compile, and looked up before asking the host.
 */
export let compileCache: { key: string; bundle: string | null; token?: string } | null = null;

/** node_modules installed in the browser (see npm/install.ts): read from shared memory, not the host. */
/**
 * The page's compiler (adapters/node/compile-worker.ts) when packages were installed in the browser:
 * a port to it, and this runtime's mailbox, where the answer is written while this thread waits.
 */
export let pageCompiler: { port: MessagePort; mailbox: SharedArrayBuffer } | null = null;

export let pack: { bytes: Uint8Array; index: Record<string, [number, number]>; message: { sab: SharedArrayBuffer; index: Record<string, [number, number]> } } | null = null;

export let vfs: Vfs = new Vfs((path) => {
  const data = installedFile(path.slice(projectRoot.length + 1));
  if (!data) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
  return data;
});

export let proc: ReturnType<typeof createProcess>;
/** This runtime as a worker thread (null in the main thread). */
export let thread: ThreadInit | null = null;
let tsRunner = false;
export let threads: ReturnType<typeof createWorkerThreads>;
export let childProcess: ReturnType<typeof createChildProcess>;
export let nodeModulesIndex: Record<string, number> | null = null;
let nodeModulesWrites: Int32Array | undefined;
let transformCache: TransformCache | null = null;

export function write(stream: 'stdout' | 'stderr', text: string) {
  post({ type: 'log', stream, text });
}

/** How the SQLite modules see files: the VFS, relative to the process's working directory. */
export function sqliteFiles(): FileAccess {
  return {
    exists: (p) => vfs.exists(p),
    read: (p) => vfs.read(p),
    write: (p, data) => vfs.write(p, data),
    resolve: (p) => (p.startsWith('/') ? p : pathBrowserify.resolve((proc.cwd as () => string)(), p.replace(/^file:/, ''))),
  };
}

/** Installed packages that are native addons, replaced by SQLite WebAssembly-backed modules. */
const SQLITE_PACKAGES: [RegExp, () => unknown][] = [
  [/\/node_modules\/better-sqlite3\//, () => createBetterSqlite3(sqliteFiles())],
  [/\/node_modules\/sqlite3\//, () => createSqlite3(sqliteFiles())],
];
const overrides = new Map<RegExp, unknown>();
let usesSqlite = false;
/**
 * The project uses top-level await somewhere: every project ES module is compiled as an async
 * module, so importers wait for their dependencies (see src/adapters/node/tla.ts). The host parses
 * the project's sources once to decide.
 */
let asyncModules = false;

let moduleSystem: ReturnType<typeof createModuleSystem>;

/**
 * Whether this runtime is one of a napi-rs WebAssembly build's threads (its `wasi-worker.mjs`).
 * Such a thread starts no threads itself: emnapi asks the thread that loaded the build to spawn
 * them (a `spawn-thread` message), so it needs no spare runtimes. Rolldown's four threads each
 * booted four spares that no one took: 16 runtimes compiling the runtime's script during a Vite
 * start. Should one start a thread after all, it gets a new runtime, as when no spare is left.
 */
export function wasiChildThread(): boolean {
  return !!thread && !thread.process && WASI_WORKER.test(thread.main);
}
const WASI_WORKER = /\/node_modules\/(?:@[^/]+\/)?[^/]+-wasm32-wasi\/wasi-worker\.mjs$/;
/** Runtime workers booted ahead of time for threads (see threads.ts). */
export const WARM_RUNTIMES = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));

/**
 * Puts each local package's files where it is linked (`links`: node_modules path → its directory,
 * project-relative), as npm's symlink shows them; module resolution and fs.realpath give the
 * package's own directory (links.ts). The package's own node_modules stays where it is.
 */
function linkLocalPackages(links: Record<string, string>, files: string[], cwd: string): void {
  for (const [at, dir] of Object.entries(links)) {
    for (const path of files) {
      if (!path.startsWith(`${dir}/`)) continue;
      const rest = path.slice(dir.length + 1);
      if (rest.startsWith('node_modules/') || rest.includes('/node_modules/')) continue;
      const to = `${cwd}/${at}/${rest}`;
      vfs.mkdir(to.slice(0, to.lastIndexOf('/')), true);
      vfs.write(to, vfs.read(`${cwd}/${path}`));
    }
  }
}

function init(msg: Extract<ToWorker, { type: 'init' }>) {
  base = msg.base;
  installKey = msg.installKey;
  preloadUrl = msg.preload ?? null;
  if (msg.trace) (globalThis as { __sandburgTraceTransfers?: boolean }).__sandburgTraceTransfers = true;
  compileCache = msg.compileCache ?? null;
  projectRoot = msg.cwd;
  thread = msg.thread ?? null;
  // SANDBURG_TS_RUNNER: started by the shell for tsx, ts-node … (see shell.ts).
  tsRunner = !!msg.tsRunner || msg.env?.SANDBURG_TS_RUNNER === '1';
  // A worker thread shares its parent's file system (installed packages it reads itself).
  prefetched = msg.prefetched ?? {};
  pack = msg.pack ? { bytes: new Uint8Array(msg.pack.sab), index: msg.pack.index, message: msg.pack } : null;
  shared = msg.shared ?? null;
  if (msg.filesChannel) useChannel(msg.filesChannel);
  sharedBytes = shared ? new Uint8Array(shared.sab) : null;
  if (thread) {
    const installed = new Vfs((path) => {
      const data = installedFile(path.slice(projectRoot.length + 1));
      if (!data) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
      return data;
    });
    for (const [rel, size] of Object.entries(msg.nodeModules ?? {})) installed.addRemote(`${msg.cwd}/${rel}`, size);
    vfs = new ThreadVfs((m) => realPostMessage(m), installed, msg.cwd, thread.snapshot, msg.nodeModulesWrites);
  }
  // The main runtime's, before the project's files are written (some may be in node_modules).
  nodeModulesWrites = thread ? msg.nodeModulesWrites : trackNodeModulesWrites(vfs, msg.cwd, msg.nodeModules);
  nodeModulesIndex = msg.nodeModules;
  for (const [path, content] of Object.entries(msg.files)) {
    const abs = `${msg.cwd}/${path}`;
    vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
    vfs.write(abs, typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0)));
  }
  if (msg.filesBundle) {
    for (const [rel, bytes] of readBundle(msg.filesBundle)) {
      const abs = `${msg.cwd}/${rel}`;
      vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
      // Files are not kept in shared memory (decoders do not read it).
      vfs.write(abs, bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes);
    }
  }
  // Local packages (workspaces, file: and link: dependencies) appear in node_modules (links.ts).
  const workspaceFile = `${msg.cwd}/${WORKSPACE_FILE}`;
  const workspace = parseWorkspace(vfs.kind(workspaceFile) === 'file' ? new TextDecoder().decode(vfs.read(workspaceFile)) : null);
  if (workspace) {
    const links = safeLinks(workspace.links);
    setLinks(links, msg.cwd);
    if (!thread) linkLocalPackages(links, Object.keys(msg.files), msg.cwd);
  }
  if (!thread) for (const [rel, size] of Object.entries(msg.nodeModules ?? {})) vfs.addRemote(`${msg.cwd}/${rel}`, size);
  // SQLite's WebAssembly engine is loaded before the program runs if it may need it (the APIs are synchronous).
  if (msg.inherit) ({ usesSqlite, asyncModules } = msg.inherit);
  else usesSqlite =
    [...Object.keys(msg.nodeModules ?? {}), ...Object.keys(msg.files)].some((rel) => /(^|\/)node_modules\/(better-sqlite3|sqlite3)\/package\.json$/.test(rel)) ||
    Object.values(msg.files).some((c) => typeof c === 'string' && c.includes('node:sqlite'));
  const sources = msg.inherit ? {} : Object.fromEntries(Object.entries(msg.files).filter(([p, c]) => typeof c === 'string' && !p.includes('node_modules/') && /\.[cm]?[jt]sx?$/.test(p) && /\bawait\b/.test(c)));
  pageCompiler = msg.compilePort ? { port: msg.compilePort, mailbox: new SharedArrayBuffer(1 << 20) } : null;
  // Programs (not their small helper threads) compile large generated code: next dev's chunks.
  if (installKey && !pageCompiler && (!thread || thread.process)) {
    startDigester();
    vfs.watch((_event, path) => digestWhenWritten(path));
    if (msg.compileAhead?.length) {
      compileAhead(msg.compileAhead.map((d) => `${msg.cwd}/${d}`), { vfs, base, compileCache });
      vfs.watch((_event, path) => compileWhenWritten(path));
    }
  } else dropPreparedDigester();
  if (Object.keys(sources).length && pageCompiler) {
    asyncModules = (JSON.parse(compileInPage({ op: 'tla', files: sources as Record<string, string> })) as { topLevelAwait: boolean }).topLevelAwait;
  } else if (Object.keys(sources).length) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/tla-scan`, false);
    xhr.send(JSON.stringify(sources));
    asyncModules = xhr.status === 200 && (JSON.parse(xhr.responseText) as { topLevelAwait: boolean }).topLevelAwait;
  }
  if (!thread) vfs.mkdir('/tmp', true);
  // WebAssembly threads (napi-rs wasm32-wasi builds) may be spawned while this thread is blocked: have runtimes ready.
  if (!wasiChildThread() && Object.keys(msg.nodeModules ?? {}).some((rel) => /-wasm32-wasi\/package\.json$/.test(rel))) warmRuntimes(msg.base, WARM_RUNTIMES);

  const child = thread?.process;
  proc = createProcess({ cwd: msg.cwd, env: { NODE_ENV: 'development', HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', ...msg.env }, argv: ['/usr/local/bin/node'], write, send: msg.ipc || child?.ipc ? (data) => post({ type: 'message', data }) : undefined });
  // A worker thread has its parent's node options (Node's default for `execArgv`); a child process has its own (below).
  if (msg.execArgv?.length) proc.execArgv = msg.execArgv;
  if (child) {
    (proc.chdir as (d: string) => void)(child.cwd);
    proc.execArgv = child.execArgv;
    // A child process's environment is exactly what its parent passed.
    proc.env = { ...msg.env };
  }
  const nested: ThreadHost = {
    vfs: () => vfs,
    childInit: (t) => ({ type: 'init', cwd: projectRoot, env: t.env, files: {}, ...(t.process ? {} : { execArgv: proc.execArgv as string[] }), installKey, preload: preloadUrl, compileCache, nodeModules: nodeModulesIndex, pack: pack?.message ?? null, shared: sharedPreload(), filesChannel: shareChannel(), compilePort: connectPageCompiler(), base, tsRunner, thread: { ...t, mainProcess: (!thread || !!thread.mainProcess) && !t.process }, inherit: { asyncModules, usesSqlite }, nodeModulesWrites }),
    write,
    cwd: () => (proc.cwd as () => string)(),
    root: () => projectRoot,
    env: () => proc.env as Record<string, string>,
    resolvePath: (p) => (p.startsWith('/') ? p : pathBrowserify.resolve((proc.cwd as () => string)(), p)),
    base: () => base,
    // A child process is a main thread of its own.
    self: child ? null : thread,
    postToParent: (m, transfer) => realPostMessage(m, transfer ?? []),
    relay: relayFromNested,
    ended: forgetNested,
    // Up to this process's main thread, and from there to the page (or the parent process).
    crash: (message, stack) => post({ type: 'fatal', message, stack, trap: true }),
  };
  threads = createWorkerThreads(nested);
  childProcess = createChildProcess({ ...nested, execPath: () => proc.execPath as string, reportExit: (info) => post({ type: 'process-exit', ...info }) });
  const table = buildBuiltins();
  const cache = new Map<string, unknown>();
  const builtin = (name: string) => {
    if (name === 'module') return moduleSystem.Module;
    if (!cache.has(name)) {
      const make = table[name];
      if (!make) throw Object.assign(new Error(`No such built-in module: node:${name}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
      cache.set(name, make());
    }
    return cache.get(name);
  };
  // Keyed by the code itself: a Map compares long strings natively, and hashing them in JavaScript
  // first was ~0.1 s of next dev's start (its 8 MB vendor chunk, twice).
  const compiledCache = new Map<string, string>();
  const hostCompile = (code: string, path: string, kind: 'esm' | 'cjs' | 'ts'): string => {
    const key = `${kind}:${path}\0${code}`;
    if (!compilesLoaded && !pageCompiler) loadCompiles(compiledCache, asyncModules);
    const hit = compiledCache.get(key);
    if (hit !== undefined) return hit;
    let out: string;
    // Packages installed in the browser: compiled in the page, on esbuild's WebAssembly build.
    if (pageCompiler) {
      out = compileInPage({ op: 'compile', code, path, kind, asyncModules: asyncModules && kind !== 'cjs' });
    } else {
      const async = asyncModules && kind !== 'cjs';
      // Large code is asked for by the digest the host keys its compiles with (compileForRuntime):
      // what the host compiled before, next dev's chunks in every later run of an app, comes back
      // without being sent. Sending 8 MB costs ~0.35 s before the host sees the request; asking, ~10 ms.
      const digest = code.length < ASK_FIRST ? null : ((kind === 'cjs' && writtenDigest(path)) || digestOf(`${kind}${async ? '\0async' : ''}\0${path}\0${code}`));
      const ahead = kind === 'cjs' ? compiledAhead(path) : null;
      const known = ahead === null && digest ? requestSync(`${base}/compiled/${digest}`, false) : null;
      if (ahead !== null) {
        out = ahead;
      } else if (known?.status === 200) {
        out = known.body as string;
      } else {
        const query = `kind=${kind}&path=${encodeURIComponent(path)}${async ? '&async=1' : ''}${compileCache ? `&cache=${compileCache.key}` : ''}`;
        // Over the file channel (~2 ms a compile in a cold Astro run) when it takes the code and the
        // answer; else a synchronous XMLHttpRequest (~7-10 ms: Playwright intercepts every request).
        // The channel has no headers: the run's capability to record compiles goes in its query.
        const fast = code.length < COMPILE_POST_MAX ? postSync(`${base}/compile?${query}${compileCache?.token ? `&token=${compileCache.token}` : ''}`, new TextEncoder().encode(code)) : null;
        let answer: { status: number; text: string };
        if (fast) {
          answer = { status: fast.status, text: new TextDecoder().decode(fast.body) };
        } else {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${base}/compile?${query}`, false);
          // The run's capability to record compiles under its key (a header: recorded demos key requests by their URL).
          if (compileCache?.token) xhr.setRequestHeader('x-sandburg-token', compileCache.token);
          // As a Blob: a string body was slower to reach the host (the 8 MB chunk: ~0.85 s -> ~0.5 s).
          xhr.send(new Blob([code]));
          answer = { status: xhr.status, text: xhr.responseText };
        }
        if (answer.status !== 200) throw Object.assign(new SyntaxError(answer.text), { code: 'ERR_COMPILE' });
        out = answer.text;
      }
    }
    compiledCache.set(key, out);
    return out;
  };
  moduleSystem = createModuleSystem({
    vfs,
    tsRunner,
    conditions: child?.conditions ?? (msg.execArgv?.length ? nodeOptions(msg.execArgv, {}).conditions : undefined),
    packageOverride(filename: string) {
      for (const [pattern, make] of SQLITE_PACKAGES) {
        if (!pattern.test(filename)) continue;
        if (!overrides.has(pattern)) overrides.set(pattern, make());
        return overrides.get(pattern);
      }
      return undefined;
    },
    compiledNodeModule(path: string) {
      // Installed in the browser: compiled as project files are, when they need it.
      if (!installKey || pack) return null;
      const rel = path.slice(projectRoot.length + 1);
      // A file the program wrote itself (Vite's node_modules/.vite-temp/…): the host has no transform of it.
      if (nodeModulesIndex && !(rel in nodeModulesIndex)) return null;
      const res = syncGet(`${base}/nm/${installKey}/t/${rel}`, false);
      return res.status === 200 ? (res.body as string) : null;
    },
    compile: hostCompile,
    builtin,
    builtinNames: [...Object.keys(table), 'module'],
    prefixOnly: new Set(['test', 'sqlite', 'sea', 'test/reporters']),
    process: proc as unknown as { dlopen(m: unknown, f: string): void },
    cwd: () => (proc.cwd as () => string)(),
    argv1: () => (proc.argv as string[])[1],
  });

  // `new AsyncFunction(…params, body)` with the body lowered like all other code (see interop.ts).
  const RealAsyncFunction = new Function('return (async function () {}).constructor')() as FunctionConstructor;
  /** Names evaluated code in stack traces after the file its inline source map is for (Vite's SSR modules). */
  const sourceUrlOf = (code: string): string => {
    const named = /\/\/[#@] sourceURL=(\S+)\s*$/m.exec(code);
    if (named) return `\n//# sourceURL=${named[1]}`;
    const map = /\/\/[#@] sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/m.exec(code);
    if (!map) return '';
    try {
      const { sources, file } = JSON.parse(atob(map[1])) as { sources?: string[]; file?: string };
      const name = sources?.[0] ?? file;
      return name ? `\n//# sourceURL=${name}` : '';
    } catch {
      return '';
    }
  };
  function AsyncFunction(...args: unknown[]) {
    const body = args.length ? String(args.pop()) : '';
    const params = args.map(String).join(',');
    try {
      const js = hostCompile(`module.exports = async function anonymous(${params}\n) {\n${body}\n};`, '/[eval]', 'cjs');
      const m = { exports: undefined as unknown };
      new Function('module', js + sourceUrlOf(body))(m);
      return m.exports;
    } catch {
      return new RealAsyncFunction(...(args as string[]), body);
    }
  }
  AsyncFunction.prototype = RealAsyncFunction.prototype;
  (globalThis as Record<symbol, unknown>)[Symbol.for('sandburg.AsyncFunction')] = AsyncFunction;
  // import() inside a Function constructor's source (see interop.ts): resolved from the working directory.
  Object.defineProperty(globalThis, '__sandburg_import', {
    configurable: true,
    value: (specifier: string) =>
      Promise.resolve().then(() => {
        const spec = String(specifier).startsWith('file:') ? decodeURIComponent(new URL(String(specifier)).pathname) : String(specifier);
        // An import(), so resolved with import conditions (as from an ES module).
        const M = moduleSystem.Module;
        const cwd = (proc.cwd as () => string)();
        const parent = new M(`${cwd}/[import]`, null);
        parent.filename = `${cwd}/[import]`;
        parent.paths = M._nodeModulePaths(cwd);
        parent.esm = true;
        const mod = M._load(spec, parent, false) as Record<string, unknown> | null;
        if (mod && typeof mod === 'object' && (mod.__esModule || (globalThis as Record<symbol, WeakSet<object>>)[Symbol.for('sandburg.esm')]?.has(mod))) return mod;
        return Object.assign(Object.create(null), mod && typeof mod === 'object' ? mod : {}, { default: mod });
      }),
  });

  // Node's console writes to process.stdout/stderr.
  const nodeUtil = builtin('util') as { format(...a: unknown[]): string; inspect(v: unknown, o?: object): string };
  const counts = new Map<string, number>();
  const times = new Map<string, number>();
  let indent = '';
  const emit = (stream: 'stdout' | 'stderr') => (...args: unknown[]) => write(stream, indent + nodeUtil.format(...args).replaceAll('\n', `\n${indent}`) + '\n');
  const nodeConsole = {
    log: emit('stdout'), info: emit('stdout'), debug: emit('stdout'),
    warn: emit('stderr'), error: emit('stderr'),
    trace: (...a: unknown[]) => emit('stderr')(`Trace: ${nodeUtil.format(...a)}\n${new Error().stack?.split('\n').slice(2).join('\n')}`),
    dir: (v: unknown, o?: object) => write('stdout', nodeUtil.inspect(v, o) + '\n'),
    dirxml: emit('stdout'),
    table: (v: unknown) => emit('stdout')(v),
    assert: (ok: unknown, ...a: unknown[]) => { if (!ok) emit('stderr')('Assertion failed' + (a.length ? `: ${nodeUtil.format(...a)}` : '')); },
    count: (l = 'default') => { counts.set(l, (counts.get(l) ?? 0) + 1); emit('stdout')(`${l}: ${counts.get(l)}`); },
    countReset: (l = 'default') => counts.delete(l),
    time: (l = 'default') => times.set(l, performance.now()),
    timeEnd: (l = 'default') => { emit('stdout')(`${l}: ${(performance.now() - (times.get(l) ?? 0)).toFixed(3)}ms`); times.delete(l); },
    timeLog: (l = 'default', ...a: unknown[]) => emit('stdout')(`${l}: ${(performance.now() - (times.get(l) ?? 0)).toFixed(3)}ms`, ...a),
    group: (...a: unknown[]) => { if (a.length) emit('stdout')(...a); indent += '  '; },
    groupCollapsed: (...a: unknown[]) => { if (a.length) emit('stdout')(...a); indent += '  '; },
    groupEnd: () => { indent = indent.slice(2); },
    profile() {}, profileEnd() {}, timeStamp() {},
  };
  (nodeConsole as Record<string, unknown>).Console = function Console() { return nodeConsole; };
  table.console = () => nodeConsole;

  // Node globals.
  const g = globalThis as Record<string, unknown>;
  installNodeFetchClasses(g);
  Object.assign(g, {
    console: nodeConsole,
    process: proc,
    Buffer,
    global: globalThis,
    setTimeout: timers.setTimeout,
    setInterval: timers.setInterval,
    clearTimeout: timers.clearTimeout,
    clearInterval: timers.clearInterval,
    setImmediate: timers.setImmediate,
    clearImmediate: timers.clearImmediate,
  });
  // Dev server plugins look their compiles up here (see transform-cache.ts); not enumerable.
  transformCache = createTransformCache(vfs, () => (proc.cwd as () => string)());
  Object.defineProperty(g, TRANSFORM_CACHE, { value: transformCache });
  Object.defineProperty(g, CONFIG_BUNDLES, { value: createConfigBundles(vfs, transformCache, () => (proc.cwd as () => string)()) });
  // esbuild's transforms on the host's native esbuild (see native-transform.ts), when there is a host.
  if (!pageCompiler && !pack) Object.defineProperty(g, NATIVE_TRANSFORM, { value: createNativeTransform({ base, hostVersion: __SANDBURG_ESBUILD__, fetch: globalThis.fetch.bind(globalThis), post: postViaChannel, pending: pendingWork }) });

  // Uncaught errors and rejections go through process events, as in Node.
  self.addEventListener('error', (e) => {
    // process.exit() from a callback (timer, I/O) ends the process there too.
    if (e.error instanceof ExitError) {
      e.preventDefault();
      return exited(e.error.code);
    }
    // In a worker thread an uncaught exception ends the thread ('error' on its Worker), as in Node.
    if (thread && !proc.listenerCount('uncaughtException')) {
      e.preventDefault();
      return postFatal(e.error ?? e.message);
    }
    if ((proc.env as Record<string, string>).SANDBURG_DEBUG_ERRORS) write('stderr', `[sandburg] uncaught: ${e.error?.stack ?? e.message}\n`);
    if (proc.listenerCount('uncaughtException')) {
      e.preventDefault();
      proc.emit('uncaughtException', e.error, 'uncaughtException');
    }
  });
  self.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof ExitError) {
      e.preventDefault();
      return exited(e.reason.code);
    }
    if (proc.listenerCount('unhandledRejection')) {
      e.preventDefault();
      proc.emit('unhandledRejection', e.reason, e.promise);
    } else if (thread && e.reason instanceof WebAssembly.RuntimeError) {
      // A trap in a promise callback ends the thread (and its process) like one in any other callback.
      e.preventDefault();
      postFatal(e.reason);
    } else {
      write('stderr', `Uncaught (in promise) ${e.reason?.stack ?? e.reason}\n`);
    }
  });
  serverEvents.on('listening', (port: number | string, ephemeral?: boolean) => {
    announce(port, ephemeral);
    serversChanged();
  });
  serverEvents.on('closed', (port: number | string) => {
    unannounce(port);
    serversChanged();
  });
  // A server on a TCP port the program chose (not a probe on one the system picked) is up.
  initProcessTree({ process: !thread || !!thread.process, serving: () => [...servers].some(([port, s]) => typeof port === 'number' && !s.ephemeral), post: (m) => post(m) });
  installNodeMessagePorts();
  hideWorkerGlobals();
  post({ type: 'ready' });
  // A worker thread starts its entry right away: its parent may be blocked in Atomics.wait until it runs.
  if (thread) run({ type: 'run', main: thread.main, argv: thread.argv, preload: thread.process?.preload });
  if (thread?.process) exitWhenIdle();
}

/** The browser's own (the runtime may install worker_threads' in its place). */
const NativeBroadcastChannel = globalThis.BroadcastChannel;
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

/**
 * A child process ends when its event loop has nothing left to do, as in Node: no ref'd timers or
 * immediates, servers, sockets, IPC channel, threads or children, or in-flight fetches. Work the
 * runtime cannot see (a pending WebAssembly compile, say) is covered by waiting for the loop to stay
 * idle for a while.
 */
function exitWhenIdle() {
  const track = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...args: A): Promise<R> => {
    pendingWork.count++;
    return fn(...args).finally(() => pendingWork.count--);
  };
  globalThis.fetch = track(globalThis.fetch.bind(globalThis));
  const wasm = WebAssembly as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) if (wasm[name]) wasm[name] = track(wasm[name].bind(WebAssembly));
  const busy = () => timersActive() || servers.size > 0 || netServers.size > 0 || netConns.size > 0 || sockets.size > 0 || !!proc.connected || liveRuntimes.size > 0;
  let idle = 0;
  const timer = nativeSetInterval(() => {
    if (hasExited) return nativeClearInterval(timer);
    idle = busy() ? 0 : idle + 1;
    if (idle < 8) return;
    idle = 0;
    const code = Number(proc.exitCode ?? 0);
    try {
      proc.emit('beforeExit', code);
      if (busy()) return;
      nativeClearInterval(timer);
      (proc.exit as (c: number) => void)(Number(proc.exitCode ?? 0));
    } catch (e) {
      nativeClearInterval(timer);
      exited(e instanceof ExitError ? e.code : 1);
    }
  }, 25);
}

function run(msg: Extract<ToWorker, { type: 'run' }>) {
  if (msg.track) vfs.track(msg.track.map((d) => `${projectRoot}/${d}`));
  if (!usesSqlite) return start(msg);
  // Work in progress: a child process that has not started its program yet is not idle (see
  // exitWhenIdle), however long SQLite's WebAssembly takes to load.
  pendingWork.count++;
  loadSqlite(base, realImportScripts)
    .then(
      () => start(msg),
      (e) => post({ type: 'fatal', message: `runtime asset failed to load: SQLite WebAssembly (${(e as Error)?.message ?? e})` }),
    )
    .finally(() => pendingWork.count--);
}

function start(msg: Extract<ToWorker, { type: 'run' }>) {
  proc.argv = ['/usr/local/bin/node', msg.main, ...(msg.argv ?? [])];
  // The main program ends like a child process does: when nothing is left to do (a CLI that exits).
  if (!thread) exitWhenIdle();
  try {
    // --require / --import (loaded in order, before the entry).
    for (const p of msg.preload ?? []) moduleSystem.Module._load(p, null, false);
    const exports = moduleSystem.Module._load(msg.main, null, true);
    // An async main module (top-level await): a rejection ends the process like an uncaught exception.
    const tla = (exports as Record<string, unknown> | null)?.__sandburg_tla as Promise<unknown> | undefined;
    if (tla && typeof tla.then === 'function') {
      tla.catch((e: unknown) => {
        if (e instanceof ExitError) return exited(e.code);
        postFatal(e);
      });
    }
  } catch (e) {
    if (e instanceof ExitError) return exited(e.code);
    postFatal(e);
  }
}

/** An uncaught error ends this runtime; a WebAssembly trap in a thread ends its process (threads.ts). */
function postFatal(e: unknown) {
  const trap = !!thread && e instanceof WebAssembly.RuntimeError;
  const message = String((e as Error)?.message ?? e);
  // What the program threw: its stack may be anything (the message types say string).
  const stack = (e as Error)?.stack ? String((e as Error).stack) : undefined;
  // Straight to the page as well: the parent that would pass the crash on may be blocked.
  if (trap && thread?.mainProcess) {
    const channel = new NativeBroadcastChannel(WASM_CRASH_CHANNEL);
    channel.postMessage({ message: `a WebAssembly thread crashed (worker ${thread.id}): RuntimeError: ${message}`, stack });
    channel.close();
  }
  post({ type: 'fatal', message, stack, ...(trap && { trap }) });
}

/**
 * Responses that end where they start (most of a dev server's: res.end(code)) go to the page as one
 * message (response-full) instead of start, chunks and end, each a task on the page's main thread
 * (which the app's frame shares) and on the service worker's. A response is held for a few
 * microtasks (res.end finishes through process.nextTick, a microtask here), not until another task:
 * that task would queue behind everything the runtime has queued. One still going then streams.
 */
const RESPONSE_HOLD_MAX = 1 << 20;
const RESPONSE_HOLD_MICROTASKS = 16;
let heldResponses: (() => void)[] = [];
function releaseHeld(depth: number) {
  if (depth > 0) return queueMicrotask(() => releaseHeld(depth - 1));
  const held = heldResponses;
  heldResponses = [];
  for (const release of held) release();
}

/** Requests to this runtime's own servers not yet answered (those to nested runtimes' are theirs). */
const inflight = new Set<number>();

/** Whether the program exited (see exited). */
let hasExited = false;

/**
 * The program exited (process.exit, or its event loop drained), once: what it scheduled no longer
 * runs, its servers are gone, and what they had not answered is answered with an error (its
 * WebSockets close); servers of its child processes, which keep running, still answer theirs.
 */
export function exited(code: number) {
  if (hasExited) return;
  hasExited = true;
  stopTimers();
  for (const id of inflight) post({ type: 'response-error', id, message: `the process exited with code ${code}` });
  inflight.clear();
  loopbackServersGone();
  for (const port of [...servers.keys()]) {
    servers.delete(port);
    serverEvents.emit('closed', port);
  }
  for (const key of [...netServers.keys()]) {
    netServers.delete(key);
    netEvents.emit('closed', key);
  }
  for (const id of sockets.keys()) post({ type: 'ws-closed', id, code: 1006, reason: '', wasClean: false });
  sockets.clear();
  post({ type: 'exit', code });
}

function request(msg: Extract<ToWorker, { type: 'request' }>) {
  const server = servers.get(msg.port);
  // A server that closed before its parent learnt of it (see unannounce): refused, as by a real port.
  if (!server) return post({ type: 'response-error', id: msg.id, message: `nothing listening on port ${msg.port}`, code: 'ECONNREFUSED' });
  const id = msg.id;
  inflight.add(id);
  /** To the page, while the request is this runtime's to answer (not once its process exited). */
  const answer = (m: Parameters<typeof post>[0], transfer?: Transferable[]) => inflight.has(id) && post(m, transfer);
  /** The start and chunks held until the end of the task; null once the response streams. */
  let held: { start: [number, string, [string, string][]] | null; chunks: Uint8Array[]; size: number } | null = { start: null, chunks: [], size: 0 };
  const release = () => {
    if (!held) return;
    const h = held;
    held = null;
    if (h.start) answer({ type: 'response-start', id, status: h.start[0], statusText: h.start[1], headers: h.start[2] });
    for (const chunk of h.chunks) answer({ type: 'response-chunk', id, chunk }, [chunk.buffer as ArrayBuffer]);
  };
  const hold = () => {
    if (heldResponses.length === 0) releaseHeld(RESPONSE_HOLD_MICROTASKS);
    heldResponses.push(release);
  };
  try {
    server.dispatch(msg.method, msg.url, msg.headers, msg.body ? new Uint8Array(msg.body) : null, {
      start: (status, statusText, headers) => {
        if (!held) return void answer({ type: 'response-start', id, status, statusText, headers });
        held.start = [status, statusText, headers];
        hold();
      },
      chunk: (data) => {
        if (held && held.size + data.length <= RESPONSE_HOLD_MAX) {
          held.chunks.push(data);
          held.size += data.length;
          return;
        }
        release();
        answer({ type: 'response-chunk', id, chunk: data }, [data.buffer as ArrayBuffer]);
      },
      end: () => {
        const start = held?.start;
        if (held && start) {
          const h = held;
          held = null;
          const body = h.chunks.length === 1 && h.chunks[0].byteOffset === 0 && h.chunks[0].byteLength === h.chunks[0].buffer.byteLength ? h.chunks[0] : concatBytes(h.chunks, h.size);
          answer({ type: 'response-full', id, status: start[0], statusText: start[1], headers: start[2], body: body.buffer as ArrayBuffer }, [body.buffer as ArrayBuffer]);
          return void inflight.delete(id);
        }
        release();
        answer({ type: 'response-end', id });
        inflight.delete(id);
      },
    });
  } catch (e) {
    // process.exit() in the handler ('request' is emitted as the request is dispatched) ends the process.
    if (e instanceof ExitError) return exited(e.code);
    release();
    answer({ type: 'response-error', id, message: String((e as Error)?.stack ?? e) });
    inflight.delete(id);
  }
}

function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

self.addEventListener('message', (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    adoptMailboxes(e.ports, msg.thread?.mailboxes);
    init(msg);
  }
  else if (msg.type === 'run') run(msg);
  else if (msg.type === 'prepare') {
    if (!proc) prepareDigester(msg.helperDelay);
  }
  else if (msg.type === 'spares') {
    if (!proc) warmRuntimes(location.pathname.replace(/\/node-worker\.js$/, ''), WARM_RUNTIMES);
  }
  else if (msg.type === 'request' && !servers.has(msg.port) && nestedPorts.has(msg.port)) forwardRequest(msg);
  else if (msg.type === 'request') request(msg);
  else if (msg.type === 'ws-open' && !servers.has(msg.port) && nestedPorts.has(msg.port)) {
    nestedSockets.set(msg.id, nestedPorts.get(msg.port)!);
    nestedSockets.get(msg.id)!.postMessage(msg);
  } else if ((msg.type === 'ws-send' || msg.type === 'ws-close') && nestedSockets.has(msg.id)) nestedSockets.get(msg.id)!.postMessage(msg);
  else if (msg.type.startsWith('net-')) netMessage(msg as NetMessage, (x, t) => realPostMessage(x, t ?? []), null);
  else if (msg.type === 'disconnect' && proc?.connected) {
    proc.connected = false;
    proc.emit('disconnect');
  }
  else if (msg.type === 'message') proc?.emit('message', msg.data);
  else if (msg.type === 'wt-message') {
    adoptMailboxes(e.ports, msg.mailboxes);
    threads.deliver(msg.data);
  }
  else if (msg.type === 'ws-open') wsOpen(msg);
  else if (msg.type.startsWith('lb-')) loopbackReply(msg as Extract<ToWorker, { type: `lb-${string}` }>);
  else if (msg.type === 'read-cache') {
    // As read-tree: compiles this run did not use go first, and an unchanged cache is not read.
    transformCache?.prune();
    if (msg.ifChanged && vfs.trackedChanged() === false) post({ type: 'cache', id: msg.id, files: [], bundle: null, unchanged: true });
    else {
      const files = listCache(vfs, projectRoot, msg.dirs);
      const bundle = msg.bytes ? bundleCache(vfs, projectRoot, files) : null;
      post({ type: 'cache', id: msg.id, files, bundle }, bundle ? [bundle] : []);
    }
  }
  else if (msg.type === 'read-tree') {
    // The project's files whose path matches, outside node_modules and dot directories.
    const files: Record<string, { base64: string }> = {};
    const pattern = new RegExp(msg.match);
    const find = (dir: string) => {
      for (const name of vfs.readdir(dir)) {
        const path = `${dir}/${name}`;
        const st = vfs.stat(path);
        if (st.kind === 'dir') {
          if (name !== 'node_modules' && !name.startsWith('.')) find(path);
        } else if (pattern.test(path.slice(projectRoot.length + 1))) {
          // Whole, whatever the size: a database without its journal would lose committed data.
          files[path.slice(projectRoot.length + 1)] = { base64: Buffer.from(vfs.read(path)).toString('base64') };
        }
      }
    };
    find(projectRoot);
    post({ type: 'tree', id: msg.id, files });
  }
    else if (msg.type === 'write-file') {
    const abs = msg.path.startsWith('/') ? msg.path : `${projectRoot}/${msg.path}`;
    vfs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', true);
    vfs.write(abs, new TextEncoder().encode(msg.content));
  }
  else if (msg.type === 'ws-send') {
    const c = sockets.get(msg.id);
    if (c?.codec.isOpen) c.socket.receive(c.codec.send(typeof msg.data === 'string' ? msg.data : new Uint8Array(msg.data)));
  } else if (msg.type === 'ws-close') {
    const c = sockets.get(msg.id);
    if (c?.codec.isOpen) c.socket.receive(c.codec.close(msg.code ?? 1000, msg.reason ?? ''));
    else if (c) c.socket.hangUp();
  }
});

const sockets = new Map<number, { socket: UpgradeSocket; codec: WsClientCodec }>();

/** Only TCP ports are the host's business; a nested runtime's parent also learns its socket paths. */
export const announce = (port: number | string, ephemeral?: boolean) => {
  if (typeof port === 'number' || thread) post({ type: 'listening', port, ...(ephemeral && { ephemeral }) });
};

/** Opens a WebSocket to a virtual server: an upgrade request, then the WebSocket protocol over the socket. */
function wsOpen(msg: Extract<ToWorker, { type: 'ws-open' }>) {
  const server = servers.get(msg.port);
  const id = msg.id;
  // The server may write (and so the client reply, e.g. pong) inside its 'upgrade' handler, before upgrade() returns.
  let early: Uint8Array[] | null = [];
  const codec = new WsClientCodec({
    accept: (protocol, extensions) => !hasExited && post({ type: 'ws-accept', id, protocol, extensions }),
    reject: (status, message) => {
      if (hasExited) return;
      sockets.delete(id);
      post({ type: 'ws-reject', id, status, message });
    },
    message: (data) => {
      if (hasExited) return;
      if (typeof data === 'string') post({ type: 'ws-message', id, data });
      else post({ type: 'ws-message', id, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
    },
    closed: (code, reason, wasClean) => {
      // Closed already, as the program exited.
      if (hasExited) return;
      sockets.get(id)?.socket.hangUp();
      sockets.delete(id);
      post({ type: 'ws-closed', id, code, reason, wasClean });
    },
    reply: (bytes) => (early ? early.push(bytes) : sockets.get(id)?.socket.receive(bytes)),
  });
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const headers: [string, string][] = [
    ...msg.headers,
    ['upgrade', 'websocket'],
    ['connection', 'Upgrade'],
    ['sec-websocket-key', key],
    ['sec-websocket-version', '13'],
    ...(msg.protocols.length ? [['sec-websocket-protocol', msg.protocols.join(', ')] as [string, string]] : []),
  ];
  const socket = server?.upgrade(msg.url, headers, { data: (bytes) => codec.receive(bytes), end: () => codec.end() });
  if (!socket) return post({ type: 'ws-reject', id, status: 404, message: server ? 'the server does not accept WebSocket connections' : `nothing listening on port ${msg.port}` });
  sockets.set(id, { socket, codec });
  for (const bytes of early) socket.receive(bytes);
  early = null;
}

export const RUNTIME_NODE_VERSION = NODE_VERSION;

// Ready for an init message (a parent keeps booted runtimes for its threads: see threads.ts).
realPostMessage({ type: 'booted' });
