/**
 * node runtime adapter (browser half): runs Sandburg's Node.js runtime in a
 * Web Worker and bridges app requests from the service worker to its virtual
 * HTTP server (ADR 0006).
 */
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, Framework, InstallReport } from '../../types.ts';
import { frameworkInfo } from '../../framework.ts';
import { connectServiceWorker, registerServiceWorker } from '../sw-bridge.ts';
import { NodeProcess, exposeWebSockets, hostBase, webSocketPort, type CacheSnapshot } from './process.ts';
import type { CacheEntry } from '../../node-runtime/cache-tree.ts';
import { DEV_ENV, matchProxy, type ProxyRule } from './scripts.ts';
import { installInBrowser, packFiles, type BrowserInstallPart } from './browser-npm/install.ts';
import { Registry } from './browser-npm/registry.ts';
import { UnsupportedSpecError } from './browser-npm/resolve.ts';
import { bundleHeader } from '../../bundle-format.ts';

export interface HostInstall {
  key: string;
  index: Record<string, number>;
  resolved: Record<string, string>;
  lockfile: boolean;
  /**
   * How to start the app (null: Next.js' programmatic dev server): a file (`main`, project-relative)
   * with arguments, or a dev script for the runtime's shell (`shell`).
   */
  /** The bundle of files earlier runs of this install loaded (see index.ts), or null. */
  preload?: string | null;
  /** A bundle of project files to start with (the Next.js seed cache, see index.ts), or null. */
  filesBundle?: string | null;
  /** Dev servers' caches from an earlier run (Vite's pre-bundled dependencies), and where they live. */
  devCache?: {
    key: string;
    dirs: string[];
    files: Record<string, string | { base64: string }>;
    /** The SHA-256 (hex) of each file of the cache the run starts from, when it comes as a bundle (filesBundle) instead of `files`. */
    digests?: Record<string, string>;
    /** Files to wait for before the cache is saved (a seed run: webpack stores its cache when idle). */
    waitFor?: string[];
    /** The run's capability to store the cache under `key`, once (see cacheWrites in index.ts). */
    token?: string;
  };
  /** Where the runtime records what the host compiles for it, and a bundle of what earlier runs of the project had compiled (see compile-cache.ts). */
  compileCache?: { key: string; bundle: string | null; token?: string } | null;
  /** Vite's server.proxy rules: WebSockets they send to a backend go to it directly. */
  proxy?: ProxyRule[];
  start?: ({ main: string; argv: string[] } | { bin: string; argv: string[] } | { shell: string }) & { command: string; tsRunner: boolean } | null;
  /** Install in the page (opt-in): what each package of the project needs (see npm/install.ts). */
  browserInstall?: BrowserInstallPart[];
}

const START = '.sandburg/start.js';
/** Where the page reaches the server on a localhost port (see ws-shim.js): /__sandburg_backend/<port>/<path>. */
const BACKEND_PREFIX = /^\/__sandburg_backend\/(\d+)(\/[^?]*)?(\?.*)?$/;

/**
 * napi-rs WebAssembly packages (rolldown, oxc, Astro's compiler, satteri) start a pool of 4 async
 * workers (emnapi's asyncWorkPoolSize) on their first async call, each a runtime here that boots and
 * instantiates the package's WebAssembly while the program waits: one each.
 */
const RUNTIME_ENV = { NAPI_RS_ASYNC_WORK_POOL_SIZE: '1' };

/** Its dev command's options from the framework's entry (FRAMEWORKS' node.devCommand), or none. */
function devCommandOptions(framework: Framework, command: string, argv: string[]): { execArgv: string[]; argv: string[] } {
  return frameworkInfo(framework)?.node?.devCommand?.(command, argv) ?? { execArgv: [], argv };
}

/** Entry scripts per framework: the programmatic equivalents of the dev commands. */
const NEXT_DEV = `// Sandburg: \`next dev\` (webpack) via Next.js' programmatic API, as a custom server runs it.
const http = require('node:http');
const next = require('next');
const port = 3000;
const app = next({ dev: true, dir: process.cwd(), hostname: 'localhost', port, webpack: true });
app
  .prepare()
  .then(() => {
    const handle = app.getRequestHandler();
    http.createServer((req, res) => handle(req, res)).listen(port, () => console.log('> Ready on http://localhost:' + port));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
`;

/** A static site (index.html, no package.json): its files, served as a static file server serves them. */
const STATIC_SERVER = `// Sandburg: a static file server for the project's files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };
const root = process.cwd();
http
  .createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root)) file = root;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  })
  .listen(3000, () => console.log('Serving on http://localhost:3000'));
`;

/** A dev script with several commands (or other packages' scripts), run by the runtime's shell as npm runs it. */
const shellStart = (script: string) => `// Sandburg: the dev script, run as npm runs it.
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(script)}, { shell: true, stdio: 'inherit', sandburgDevScript: true });
child.on('exit', (code) => process.exit(code ?? 1));
`;

/** The SHA-256 (hex) of a file of a cache. */
async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The files of a cache's bundle (readCache), as [path, bytes] (views of the bundle). */
function bundleFiles(bundle: ArrayBuffer): [string, Uint8Array][] {
  const { header, body } = bundleHeader<[string, string, number]>(new Uint8Array(bundle));
  let at = body;
  return header.map(([, path, size]) => [path, new Uint8Array(bundle, (at += size) - size, size)]);
}

/** Whether two looks at a cache found the same files, none written in between (same sizes and mtimes). */
function sameFiles(a: CacheEntry[], b: CacheEntry[] | undefined): boolean {
  return !!b && a.length === b.length && a.every(([path, size, mtimeMs], i) => b[i][0] === path && b[i][1] === size && b[i][2] === mtimeMs);
}

/** Whether a file the run started with (text, or binary as base64) has these bytes. */
function sameBytes(file: string | { base64: string } | undefined, bytes: Uint8Array): boolean {
  if (file === undefined) return false;
  const had = typeof file === 'string' ? new TextEncoder().encode(file) : Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  return had.length === bytes.length && had.every((b, i) => b === bytes[i]);
}

/**
 * Dev servers that start WebAssembly threads (Vite 8's rolldown and oxc, Astro's compiler: napi-rs
 * builds) as they start: their runtime starts its spare runtimes (threads.ts) while it waits for its
 * init message, from the mount. A parent's first messages to a new worker wait until the parent's
 * thread has handled the worker's start (Chromium holds them until the parent runs a task after the
 * worker's script has run), and a runtime running its program is busy for hundreds of milliseconds
 * at a time: spares it started then took their wake-up, and their first thread's init, 200-500 ms
 * after they were sent. Started at the mount, they are ready when the program starts its threads.
 * Not for other apps: four spares, however idle, made a warm node-express run 4% slower (n=8).
 *
 * Whether the app's runtime starts its spares at the mount: those dev servers (FRAMEWORKS'
 * node.sparesAtMount), and projects of several packages (a client and a server), which run them as
 * child processes.
 */
function startsThreads(tree: FileTree, framework: Framework): boolean {
  return !!frameworkInfo(framework)?.node?.sparesAtMount || Object.keys(tree).some((path) => path !== 'package.json' && path.endsWith('/package.json') && !path.includes('node_modules/'));
}

/**
 * The runtime worker for the next process, started as the host page loads: it loads and evaluates
 * the runtime (~200 ms) while the run mounts the project and the host installs it, and waits for its
 * init message. One that failed to load is not used: the process starts its own and reports its error.
 */
let prepared: { worker: Worker; failed: boolean } | null = null;

/**
 * Started once the service worker is active: a runtime is its client from its start, and imports
 * the runtime's module through it, from Cache Storage, where V8's code for the module is
 * kept for the run's other runtimes (node-runtime/runtime-module.ts). Without a service worker, as
 * before.
 */
let preparing = false;

export function prepare(): void {
  if (prepared || preparing) return;
  preparing = true;
  const start = () => {
    // Taken (as none) before the service worker was ready: the process started its own.
    if (!preparing) return;
    preparing = false;
    const p = { worker: new Worker(`${hostBase()}/node-worker.js`), failed: false };
    p.worker.postMessage({ type: 'prepare' });
    p.worker.onerror = (e) => {
      e.preventDefault();
      p.failed = true;
    };
    prepared = p;
  };
  registerServiceWorker().then(start, start);
}

function preparedWorker(): Worker | undefined {
  preparing = false;
  const p = prepared;
  prepared = null;
  if (p?.failed) p.worker.terminate();
  return p && !p.failed ? p.worker : undefined;
}

/** A port to the page's compiler for a runtime (each runtime blocks on its own; see compile-worker.ts). */
function connectCompiler(compiler: Worker): MessagePort {
  const channel = new MessageChannel();
  compiler.postMessage({ op: 'connect', port: channel.port2 }, [channel.port2]);
  return channel.port1;
}

export function createAdapter(): RuntimeAdapter {
  let files: FileTree = {};
  let proc: NodeProcess | null = null;
  /** The page's compiler, when the packages are installed in the browser, and its failure. */
  let compiler: Worker | null = null;
  let compilerError: AdapterError | null = null;
  let main = `/app/${START}`;
  let argv: string[] = [];
  let execArgv: string[] = [];
  let shell = false;
  let proxy: ProxyRule[] = [];
  let devCache: HostInstall['devCache'] | null = null;
  /**
   * A dev server whose first build fails reports it and waits for a fix instead of serving (ng serve:
   * "Application bundle generation failed", then "Watch mode enabled"): that ends the start.
   */
  let buildFailed = false;
  const watchBuild = (line: string) => {
    const text = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (/Application bundle generation failed/.test(text)) buildFailed = true;
    else if (buildFailed && /Watch mode enabled/.test(text) && proc && !proc.ports.length) {
      proc.fail(new AdapterError('APP', 'the dev server could not build the app and is waiting for changes (see the errors above)'));
    }
  };

  return {
    name: 'node',

    async mount(tree: FileTree, ctx: AdapterContext) {
      if (startsThreads(tree, ctx.framework)) prepared?.worker.postMessage({ type: 'spares' });
      files = { ...tree };
      if (ctx.framework === 'static') files[START] = STATIC_SERVER;
      else if (!ctx.packageJson) throw new AdapterError('APP', 'package.json is missing or invalid');
      if (ctx.framework === 'next') files[START] = NEXT_DEV;
    },

    async install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport> {
      const host = hostData as HostInstall;
      proxy = host.proxy ?? [];
      devCache = host.devCache ?? null;
      Object.assign(files, devCache?.files);
      let nodeModules = host.index;
      let pack: ReturnType<typeof packFiles> | null = null;
      let resolved = host.resolved;
      let bins: Record<string, string> = {};
      if (host.browserInstall) {
        // Opt-in: the install happens here, from the npm registry (see npm/install.ts), and the runtime
        // compiles in the page (compile-worker.ts), not on the host. Its esbuild loads meanwhile.
        if (!compiler) {
          compiler = new Worker(`${hostBase()}/compile-worker.js`);
          // Runtimes wait for its answers: if it fails, so does the run, instead of waiting out a deadline.
          compiler.onerror = (e) => {
            e.preventDefault();
            compilerError = new AdapterError('INTERNAL', `the page's compiler failed: ${e.message || 'worker error'}`);
            proc?.fail(compilerError);
          };
        }
        let result;
        try {
          result = await installInBrowser(host.browserInstall, new Registry(), (line) => ctx.log('stdout', line));
        } catch (e) {
          if (e instanceof UnsupportedSpecError) throw new AdapterError('UNSUPPORTED', e.message);
          // A package or version the registry does not have is the app's (worded as npm words it, so
          // classify.ts finds it); the registry failing to answer, or a broken download, is not.
          throw new AdapterError(/^npm error (?:404|notarget) /.test((e as Error).message) ? 'APP' : 'INTERNAL', (e as Error).message);
        }
        pack = packFiles(result.files);
        nodeModules = Object.fromEntries(Object.entries(pack.index).map(([path, [, length]]) => [path, length]));
        resolved = result.resolved;
        host.lockfile = result.lockfile;
        const index = result.files.get('node_modules/.sandburg-bins.json');
        if (index) bins = JSON.parse(new TextDecoder().decode(index)) as Record<string, string>;
      }
      if (ctx.framework !== 'next') {
        if (!host.start) throw new AdapterError('UNSUPPORTED', 'no way to start this project in the node runtime');
        shell = 'shell' in host.start;
        if ('shell' in host.start) files[START] = shellStart(host.start.shell);
        else if ('bin' in host.start) {
          if (!bins[host.start.bin]) throw new AdapterError('APP', `the dev script runs "${host.start.bin}", which no installed package provides`);
          main = `/app/${bins[host.start.bin]}`;
          ({ execArgv, argv } = devCommandOptions(ctx.framework, host.start.command, host.start.argv));
        } else {
          main = `/app/${host.start.main}`;
          ({ execArgv, argv } = devCommandOptions(ctx.framework, host.start.command, host.start.argv));
        }
        ctx.log('stdout', `starting: ${host.start.command}`);
      }
      if (compilerError) throw compilerError;
      proc = new NodeProcess({
        worker: preparedWorker(),
        tsRunner: host.start?.tsRunner,
        execArgv,
        files,
        // PORT only for a single server: the servers of a dev script listen where it says.
        // SANDBURG_WEBPACK_CACHE_READONLY: webpack reads its cache (a seed) but does not store it, unless
        // this run keeps the cache (a seed run waits for its files); see SOURCE_PATCHES in install.ts.
        env: { ...DEV_ENV, ...RUNTIME_ENV, ...(host.start && 'shell' in host.start ? {} : { PORT: '3000' }), ...frameworkInfo(ctx.framework)?.node?.env, ...(devCache?.waitFor ? {} : { SANDBURG_WEBPACK_CACHE_READONLY: '1' }) },
        installKey: host.key,
        preload: host.preload ?? null,
        filesBundle: host.filesBundle ?? null,
        compileCache: host.compileCache ?? null,
        compileAhead: frameworkInfo(ctx.framework)?.node?.compileAhead,
        nodeModules,
        pack,
        compilePort: compiler ? connectCompiler(compiler) : null,
        log: (stream, line) => {
          ctx.log(stream, line);
          watchBuild(line);
        },
      });
      await proc.started();
      return {
        resolution: host.lockfile ? 'lockfile' : Object.keys(ctx.packageJson?.dependencies ?? {}).length ? 'range' : 'none',
        lockfileHonored: host.lockfile,
        dependencies: resolved,
        buildMs: null,
      };
    },

    async start() {
      if (!proc) throw new AdapterError('INTERNAL', 'install() has not run');
      const p = proc;
      let port = 0;
      await connectServiceWorker((request, reply) => {
        const direct = BACKEND_PREFIX.exec(request.url);
        if (!direct) return p.request(port, request, reply);
        const target = Number(direct[1]);
        if (!p.ports.includes(target)) return reply.postMessage({ type: 'error', message: `nothing is listening on localhost:${target}` });
        p.request(target, { ...request, url: (direct[2] ?? '/') + (direct[3] ?? '') }, reply);
      });
      // Edits to the running app (sandburg open, checks that exercise hot reloading).
      window.__sandburgWriteFile = (path: string, content: string) => p.writeFile(path, content);
      // Files the app wrote (a page that runs the project again keeps its SQLite databases).
      window.__sandburgReadFiles = (match: string) => p.readTree(match);
      // WebSockets (e.g. Next.js' HMR at /_next/webpack-hmr) go to the app's server too.
      exposeWebSockets((url) => {
        const target = webSocketPort(url, p.ports, (path) => {
          // Vite proxies WebSockets (e.g. '/socket.io': { target, ws: true }) to a backend: straight there.
          const rule = matchProxy(proxy, path)?.rule;
          return rule && p.ports.includes(rule.port) ? rule.port : port || null;
        });
        return target ? { proc: p, port: target } : null;
      });
      // A cache restored from an earlier run is stored again only if the run changed it (see dispose).
      p.run(main, argv, devCache?.digests && !devCache.waitFor ? devCache.dirs : undefined);
      // A dev script may start several servers (an API and the page's dev server): the page's is the app.
      port = shell ? await p.pagePort() : await p.listening();
      p.appPort = port;
      // One of the dev script's servers crashed while the others came up (concurrently keeps going): the app is broken.
      const crashed = p.failedCommands[0];
      if (crashed) throw new AdapterError('APP', `"${crashed.command}" exited with code ${crashed.code}${crashed.stderr ? `:\n${crashed.stderr.trim().split('\n').slice(-15).join('\n')}` : ''}`);
      return { url: '/' };
    },

    activity() {
      return proc?.activity() ?? null;
    },

    failed() {
      return proc ? proc.failed() : new Promise<never>(() => {});
    },

    async dispose() {
      // Keep the dev server's dependency cache for the next run, once it is complete (Vite writes _metadata.json last).
      if (proc && devCache && !proc.failure) {
        const p = proc;
        const { dirs, waitFor, digests } = devCache;
        // A look gives up after 5 s.
        const look = (bytes: boolean, ifChanged = false) => Promise.race([p.readCache(dirs, { bytes, ifChanged }), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
        let cache: CacheSnapshot | null;
        /** Whether the cache is complete: for one that waits (waitFor), its tree settled (every file there, none mid-write, unchanged since the last look). */
        let complete = false;
        if (waitFor) {
          // Until the files are there and the tree stops changing (webpack stores its cache after an idle moment):
          // its list of files and sizes, then its bytes once. At most 40 s, however long each look takes.
          // webpack writes each pack under a temporary name (<name>_), then renames it.
          const deadline = performance.now() + 40_000;
          let last = await look(false);
          while (performance.now() < deadline && !complete) {
            await new Promise((r) => setTimeout(r, 250));
            const next = await look(false);
            const names = new Set(next?.files.map(([path]) => path));
            complete = !!next && waitFor.every((f) => names.has(f)) && !next.files.some(([path]) => path.endsWith('_')) && sameFiles(next.files, last?.files);
            last = next;
          }
          cache = complete ? await look(true) : null;
          // One that changed again as its bytes were read is not stored: it may hold a pack webpack was still writing.
          complete = !!cache && sameFiles(cache.files, last?.files);
        } else {
          // A cache restored from an earlier run, whose directories the runtime tracked (see start), is
          // read only if the run changed a file there: null when it did not (nothing to store).
          cache = await look(true, !!digests);
          // Vite writes an optimized environment's _metadata.json last.
          complete = !!cache && cache.files.some(([path]) => path.endsWith('/_metadata.json'));
        }
        const files = complete && cache?.bundle ? bundleFiles(cache.bundle) : null;
        const changed =
          !!files &&
          // A file the run deleted counts as a change too.
          (digests
            ? Object.keys(digests).length !== files.length || (await Promise.all(files.map(async ([path, bytes]) => digests[path] === (await sha256(bytes))))).includes(false)
            : Object.keys(devCache.files).length !== files.length || files.some(([path, bytes]) => !sameBytes(devCache!.files[path], bytes)));
        if (changed && devCache.token) {
          // A Blob, not the ArrayBuffer: DevTools (Playwright's Network domain) is handed an ArrayBuffer
          // body as the request's post data, which took a 27 MB cache's upload from 0.4 to 1.6 s.
          await fetch(`${hostBase()}/dev-cache/${devCache.key}`, { method: 'POST', headers: { 'x-sandburg-token': devCache.token, 'content-type': 'application/octet-stream' }, body: new Blob([cache!.bundle!]) }).catch(() => {});
        }
      }
      proc?.terminate();
      proc = null;
      compiler?.terminate();
      compiler = null;
      compilerError = null;
    },
  };
}
