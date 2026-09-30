/**
 * node runtime adapter (browser half): runs Sandburg's Node.js runtime in a
 * Web Worker and bridges app requests from the service worker to its virtual
 * HTTP server (ADR 0006).
 */
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import { connectServiceWorker } from '../sw-bridge.ts';
import { NodeProcess } from './process.ts';

export interface HostInstall {
  key: string;
  index: Record<string, number>;
  resolved: Record<string, string>;
  lockfile: boolean;
}

const START = '.sandburg/start.js';

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

export function createAdapter(): RuntimeAdapter {
  let files: FileTree = {};
  let proc: NodeProcess | null = null;

  return {
    name: 'node',

    async mount(tree: FileTree, ctx: AdapterContext) {
      files = { ...tree };
      if (!ctx.packageJson) throw new AdapterError('APP', 'package.json is missing or invalid');
      if (ctx.framework === 'next') files[START] = NEXT_DEV;
      else {
        const script = ctx.packageJson.scripts?.dev ?? ctx.packageJson.scripts?.start ?? '';
        const main = /^node\s+(\S+)/.exec(script)?.[1] ?? (typeof ctx.packageJson.main === 'string' ? ctx.packageJson.main : null);
        if (!main) throw new AdapterError('UNSUPPORTED', `no way to start this project in the node runtime (dev/start script: "${script}")`);
        files[START] = `require(${JSON.stringify(`../${main.replace(/^\.\//, '')}`)});\n`;
      }
    },

    async install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport> {
      const host = hostData as HostInstall;
      proc = new NodeProcess({
        files,
        // NEXT_TEST_WASM: load SWC's WebAssembly build (there is no native SWC in the browser).
        env: { NEXT_TELEMETRY_DISABLED: '1', PORT: '3000', CI: '1', ...(ctx.framework === 'next' ? { NEXT_TEST_WASM: '1' } : {}) },
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
      await connectServiceWorker((request, reply) => p.request(port, request, reply));
      p.run(`/app/${START}`);
      port = await p.listening();
      return { url: '/' };
    },

    async dispose() {
      proc?.terminate();
      proc = null;
    },
  };
}
