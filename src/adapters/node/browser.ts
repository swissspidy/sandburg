/**
 * node runtime adapter (browser half): runs Sandburg's Node.js runtime in a
 * Web Worker and bridges app requests from the service worker to its virtual
 * HTTP server (ADR 0006).
 */
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import type { FromWorker } from '../../node-runtime/worker.ts';

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
  let worker: Worker | null = null;
  let listeningPort = 0;
  let failure: Error | null = null;
  const waiters = new Set<() => void>();
  const pending = new Map<number, MessagePort>();
  let nextId = 1;

  const notify = () => {
    for (const w of waiters) w();
  };
  const until = (cond: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (failure) {
          waiters.delete(check);
          reject(failure);
        } else if (cond()) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });

  function onWorkerMessage(e: MessageEvent<FromWorker>, ctx: AdapterContext) {
    const m = e.data;
    switch (m.type) {
      case 'log':
        for (const line of m.text.replace(/\n$/, '').split('\n')) ctx.log(m.stream, line);
        break;
      case 'listening':
        listeningPort ||= m.port;
        notify();
        break;
      case 'fatal':
        failure = new AdapterError('APP', m.stack ?? m.message);
        notify();
        break;
      case 'exit':
        if (!listeningPort) failure = new AdapterError('APP', `the app exited with code ${m.code} before it started listening`);
        notify();
        break;
      case 'response-start': {
        const port = pending.get(m.id);
        for (const [k, v] of m.headers) if (k.toLowerCase() === 'set-cookie') applyCookie(v);
        port?.postMessage({ type: 'start', status: m.status, statusText: m.statusText, headers: m.headers });
        break;
      }
      case 'response-chunk':
        pending.get(m.id)?.postMessage({ type: 'chunk', chunk: m.chunk }, [m.chunk.buffer]);
        break;
      case 'response-end':
        pending.get(m.id)?.postMessage({ type: 'end' });
        pending.get(m.id)?.close();
        pending.delete(m.id);
        break;
      case 'response-error':
        pending.get(m.id)?.postMessage({ type: 'error', message: m.message });
        pending.delete(m.id);
        break;
      case 'ready':
        notify();
        break;
    }
  }

  let ready = false;

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
      worker = new Worker('/__sandburg/node-worker.js');
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') ready = true;
        onWorkerMessage(e, ctx);
      };
      worker.onerror = (e) => {
        failure = new AdapterError('INTERNAL', `runtime worker error: ${e.message}`);
        notify();
      };
      worker.postMessage({
        type: 'init',
        cwd: '/app',
        env: { NEXT_TELEMETRY_DISABLED: '1', PORT: '3000', CI: '1' },
        files,
        installKey: host.key,
        nodeModules: host.index,
        base: '/__sandburg',
      });
      await until(() => ready);
      return {
        resolution: host.lockfile ? 'lockfile' : Object.keys(ctx.packageJson?.dependencies ?? {}).length ? 'range' : 'none',
        lockfileHonored: host.lockfile,
        dependencies: host.resolved,
        buildMs: null,
      };
    },

    async start() {
      if (!worker) throw new AdapterError('INTERNAL', 'install() has not run');
      await connectServiceWorker((request, port) => {
        const id = nextId++;
        pending.set(id, port);
        const headers: [string, string][] = request.headers.filter(([k]) => k.toLowerCase() !== 'cookie');
        if (document.cookie) headers.push(['cookie', document.cookie]);
        worker!.postMessage({ type: 'request', id, port: listeningPort, method: request.method, url: request.url, headers, body: request.body }, request.body ? [request.body] : []);
      });
      worker.postMessage({ type: 'run', main: `/app/${START}` });
      await until(() => listeningPort > 0);
      return { url: '/' };
    },

    async dispose() {
      worker?.terminate();
      worker = null;
    },
  };
}

interface BridgedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

/** Registers the service worker and keeps handing it a port for app requests. */
async function connectServiceWorker(onRequest: (r: BridgedRequest, port: MessagePort) => void): Promise<void> {
  const registration = await navigator.serviceWorker.register('/__sw__.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  }
  const give = () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => onRequest(e.data as BridgedRequest, e.ports[0]);
    (navigator.serviceWorker.controller ?? registration.active)!.postMessage({ type: 'sandburg-port' }, [channel.port2]);
  };
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sandburg-need-port') give();
  });
  give();
}

/** Applies a Set-Cookie header to the sandbox origin (a service worker cannot). HttpOnly cannot be honored. */
function applyCookie(header: string) {
  const [pair, ...attrs] = header.split(';');
  const kept = attrs.map((a) => a.trim()).filter((a) => !/^(httponly|secure)$/i.test(a));
  document.cookie = [pair.trim(), ...kept].join('; ');
}
