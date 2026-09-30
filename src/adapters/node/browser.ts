/**
 * node runtime adapter (browser half): runs Sandburg's Node.js runtime in a
 * Web Worker and bridges app requests from the service worker to its virtual
 * HTTP server (ADR 0006).
 */
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import { connectServiceWorker } from '../sw-bridge.ts';
import { NodeProcess, exposeWebSockets, webSocketPort } from './process.ts';
import { matchProxy, type ProxyRule } from '../esbuild/backend.ts';

export interface HostInstall {
  key: string;
  index: Record<string, number>;
  resolved: Record<string, string>;
  lockfile: boolean;
  /**
   * How to start the app (null: Next.js' programmatic dev server): a file (`main`, project-relative)
   * with arguments, or a dev script for the runtime's shell (`shell`).
   */
  /** Vite's server.proxy rules: WebSockets they send to a backend go to it directly. */
  proxy?: ProxyRule[];
  start?: ({ main: string; argv: string[] } | { shell: string }) & { command: string; tsRunner: boolean } | null;
}

const START = '.sandburg/start.js';
/** Where the page reaches the server on a localhost port (see ws-shim.js): /__sandburg_backend/<port>/<path>. */
const BACKEND_PREFIX = /^\/__sandburg_backend\/(\d+)(\/[^?]*)?(\?.*)?$/;

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

/** A dev script with several commands (or other packages' scripts), run by the runtime's shell as npm runs it. */
const shellStart = (script: string) => `// Sandburg: the dev script, run as npm runs it.
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(script)}, { shell: true, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
`;

export function createAdapter(): RuntimeAdapter {
  let files: FileTree = {};
  let proc: NodeProcess | null = null;
  let main = `/app/${START}`;
  let argv: string[] = [];
  let shell = false;
  let proxy: ProxyRule[] = [];

  return {
    name: 'node',

    async mount(tree: FileTree, ctx: AdapterContext) {
      files = { ...tree };
      if (!ctx.packageJson) throw new AdapterError('APP', 'package.json is missing or invalid');
      if (ctx.framework === 'next') files[START] = NEXT_DEV;
    },

    async install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport> {
      const host = hostData as HostInstall;
      proxy = host.proxy ?? [];
      if (ctx.framework !== 'next') {
        if (!host.start) throw new AdapterError('UNSUPPORTED', 'no way to start this project in the node runtime');
        shell = 'shell' in host.start;
        if ('shell' in host.start) files[START] = shellStart(host.start.shell);
        else {
          main = `/app/${host.start.main}`;
          argv = host.start.argv;
        }
        ctx.log('stdout', `starting: ${host.start.command}`);
      }
      proc = new NodeProcess({
        tsRunner: host.start?.tsRunner,
        files,
        // NEXT_TEST_WASM: load SWC's WebAssembly build (there is no native SWC in the browser).
        // PORT only for a single server: the servers of a dev script listen where it says.
        env: { NEXT_TELEMETRY_DISABLED: '1', ...(host.start && 'shell' in host.start ? {} : { PORT: '3000' }), CI: '1', ...(ctx.framework === 'next' ? { NEXT_TEST_WASM: '1' } : {}) },
        installKey: host.key,
        nodeModules: host.index,
        log: (stream, line) => ctx.log(stream, line),
      });
      await proc.started();
      return {
        resolution: host.lockfile ? 'lockfile' : Object.keys(ctx.packageJson?.dependencies ?? {}).length ? 'range' : 'none',
        lockfileHonored: host.lockfile,
        dependencies: host.resolved,
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
      return { url: '/' };
    },

    async dispose() {
      proc?.terminate();
      proc = null;
    },
  };
}
