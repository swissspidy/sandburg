/**
 * Serves sandbox host pages. One HTTP server answers for every sandbox; each
 * sandbox is its own origin, http://<id>.sandburg.localhost:<port>, so service
 * workers, storage and cookies never mix between parallel tabs (ADR 0001).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import * as esbuild from 'esbuild';
import type { AdapterDescriptor } from '../types.ts';

const HOST_ENTRY = fileURLToPath(new URL('../host/host.ts', import.meta.url));
export const SANDBOX_DOMAIN = 'sandburg.localhost';

const HOST_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>sandburg</title>
<style>html,body{margin:0;height:100%}#app{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<iframe id="app" title="app"></iframe>
<script type="module" src="/__sandburg/host.js"></script>
</body>
</html>
`;

const bundles = new Map<string, Promise<string>>();

/** Bundles the host page with the adapter's browser module. Cached per adapter. */
export function bundleHost(adapter: AdapterDescriptor): Promise<string> {
  let bundle = bundles.get(adapter.name);
  if (!bundle) {
    const aliases: Record<string, string> = { 'sandburg:adapter': adapter.browserEntry, ...adapter.bundleAliases };
    bundle = esbuild
      .build({
        entryPoints: [HOST_ENTRY],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent',
        define: adapter.bundleDefines,
        plugins: [
          {
            name: 'sandburg-aliases',
            setup(build) {
              const filter = new RegExp(`^(${Object.keys(aliases).map(escapeRegExp).join('|')})$`);
              build.onResolve({ filter }, (args) => ({ path: aliases[args.path] }));
            },
          },
        ],
      })
      .then((result) => result.outputFiles[0].text);
    bundle.catch(() => bundles.delete(adapter.name));
    bundles.set(adapter.name, bundle);
  }
  return bundle;
}

export class HostServer {
  private server: Server;
  private sandboxes = new Map<string, AdapterDescriptor>();
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err?.stack ?? err));
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Registers a sandbox and returns its origin. `id` must be a DNS label. */
  register(id: string, adapter: AdapterDescriptor): string {
    if (!/^[a-z0-9-]{1,63}$/.test(id)) throw new Error(`invalid sandbox id: ${id}`);
    this.sandboxes.set(id, adapter);
    return this.origin(id);
  }

  unregister(id: string): void {
    this.sandboxes.delete(id);
  }

  origin(id: string): string {
    return `http://${id}.${SANDBOX_DOMAIN}:${this.port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    const id = host.endsWith(`.${SANDBOX_DOMAIN}:${this.port}`) ? host.split('.')[0] : null;
    const adapter = id ? this.sandboxes.get(id) : undefined;
    if (!adapter) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('unknown sandbox');
      return;
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (adapter.crossOriginIsolation) {
      headers['cross-origin-opener-policy'] = 'same-origin';
      headers['cross-origin-embedder-policy'] = adapter.crossOriginIsolation === 'credentialless' ? 'credentialless' : 'require-corp';
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/' || path === '/index.html' || path === '/__sandburg/') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(HOST_HTML);
    } else if (path === '/__sandburg/host.js') {
      const js = await bundleHost(adapter);
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
    } else if (path.startsWith('/__sandburg/') && adapter.serve) {
      const url = new URL(req.url ?? '/', 'http://x');
      const out = await adapter.serve({
        method: req.method ?? 'GET',
        path,
        query: url.searchParams,
        body: async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          return Buffer.concat(chunks);
        },
      });
      if (!out) {
        res.writeHead(404, { ...headers, 'content-type': 'text/plain' });
        res.end('not found');
      } else {
        res.writeHead(out.status, { ...headers, ...out.headers });
        res.end(out.body);
      }
    } else if (adapter.assets[path]) {
      const body = await readFile(adapter.assets[path]);
      res.writeHead(200, { ...headers, 'content-type': contentType(path) });
      res.end(body);
    } else {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain' });
      res.end('not found');
    }
  }
}

function contentType(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
