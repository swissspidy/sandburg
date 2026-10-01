/**
 * node runtime adapter (browser half): runs Sandburg's Node.js runtime in a
 * Web Worker and bridges app requests from the service worker to its virtual
 * HTTP server (ADR 0006).
 */
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import { connectServiceWorker } from '../sw-bridge.ts';
import { NodeProcess, exposeWebSockets, webSocketPort } from './process.ts';
import { DEV_ENV, matchProxy, type ProxyRule } from './scripts.ts';
import { installInBrowser, packFiles, type BrowserInstallPart } from '../../node-runtime/npm/install.ts';
import { Registry } from '../../node-runtime/npm/registry.ts';
import { UnsupportedSpecError } from '../../node-runtime/npm/resolve.ts';

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
    /** Files to wait for before the cache is saved (a seed run: webpack stores its cache when idle). */
    waitFor?: string[];
  };
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
 * Next.js in the runtime: SWC's WebAssembly build (there is no native SWC in the browser), and
 * next.config.ts loaded with Node's own type stripping, as `--experimental-next-config-strip-types`
 * does. The default path transpiles it with SWC to CommonJS, which SWC's WebAssembly build stopped
 * doing in Next.js 16 (it leaves the module ESM).
 */
const NEXT_ENV = { NEXT_TEST_WASM: '1', __NEXT_NODE_NATIVE_TS_LOADER_ENABLED: 'true' };

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
const child = spawn(${JSON.stringify(script)}, { shell: true, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
`;

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
          compiler = new Worker('/__sandburg/compile-worker.js');
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
          argv = host.start.argv;
        } else {
          main = `/app/${host.start.main}`;
          argv = host.start.argv;
        }
        ctx.log('stdout', `starting: ${host.start.command}`);
      }
      if (compilerError) throw compilerError;
      proc = new NodeProcess({
        tsRunner: host.start?.tsRunner,
        files,
        // PORT only for a single server: the servers of a dev script listen where it says.
        // SANDBURG_WEBPACK_CACHE_READONLY: webpack reads its cache (a seed) but does not store it, unless
        // this run keeps the cache (a seed run waits for its files); see SOURCE_PATCHES in install.ts.
        env: { ...DEV_ENV, ...(host.start && 'shell' in host.start ? {} : { PORT: '3000' }), ...(ctx.framework === 'next' ? NEXT_ENV : {}), ...(devCache?.waitFor ? {} : { SANDBURG_WEBPACK_CACHE_READONLY: '1' }) },
        installKey: host.key,
        preload: host.preload ?? null,
        filesBundle: host.filesBundle ?? null,
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
      (window as unknown as Record<string, unknown>).__sandburgWriteFile = (path: string, content: string) => p.writeFile(path, content);
      // WebSockets (e.g. Next.js' HMR at /_next/webpack-hmr) go to the app's server too.
      exposeWebSockets((url) => {
        const target = webSocketPort(url, p.ports, (path) => {
          // Vite proxies WebSockets (e.g. '/socket.io': { target, ws: true }) to a backend: straight there.
          const rule = matchProxy(proxy, path)?.rule;
          return rule && p.ports.includes(rule.port) ? rule.port : port || null;
        });
        return target ? { proc: p, port: target } : null;
      });
      p.run(main, argv);
      // A dev script may start several servers (an API and the page's dev server): the page's is the app.
      port = shell ? await p.pagePort() : await p.listening();
      // One of the dev script's servers crashed while the others came up (concurrently keeps going): the app is broken.
      const crashed = p.failedCommands[0];
      if (crashed) throw new AdapterError('APP', `"${crashed.command}" exited with code ${crashed.code}${crashed.stderr ? `:\n${crashed.stderr.trim().split('\n').slice(-15).join('\n')}` : ''}`);
      return { url: '/' };
    },

    activity() {
      return proc?.activity() ?? null;
    },

    async dispose() {
      // Keep the dev server's dependency cache for the next run, once it is complete (Vite writes _metadata.json last).
      if (proc && devCache && !proc.failure) {
        const read = () => Promise.race([proc!.readTree(devCache!.dirs), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
        let tree = await read();
        if (devCache.waitFor) {
          // Until the files are there and the tree stops changing (webpack stores its cache after an idle moment).
          const size = (t: typeof tree) => (t ? Object.values(t).reduce((n, f) => n + (typeof f === 'string' ? f.length : f.base64.length), 0) : -1);
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            const next = await read();
            const ready = next && devCache.waitFor.every((f) => f in next);
            if (ready && size(next) === size(tree)) break;
            tree = next;
          }
        }
        const complete = tree && (devCache.waitFor ? devCache.waitFor.every((f) => f in tree!) : devCache.dirs.some((d) => `${d}/_metadata.json` in tree!));
        const same = (a: string | { base64: string } | undefined, b: string | { base64: string }) => (typeof a === 'string' || typeof b === 'string' ? a === b : a?.base64 === b.base64);
        const changed = complete && Object.keys(tree!).some((p) => !same(devCache!.files[p], tree![p]));
        if (changed) await fetch(`/__sandburg/dev-cache/${devCache.key}`, { method: 'POST', body: JSON.stringify(tree) }).catch(() => {});
      }
      proc?.terminate();
      proc = null;
      compiler?.terminate();
      compiler = null;
      compilerError = null;
    },
  };
}
