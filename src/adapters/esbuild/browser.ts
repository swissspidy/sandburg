/**
 * esbuild adapter (browser half): builds the app with esbuild-wasm in the
 * host page and answers the app frame's requests from the build output,
 * through the sandbox's service worker (ADR 0007).
 */
import * as esbuild from 'esbuild-wasm';
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import { connectServiceWorker, type BridgedRequest } from '../sw-bridge.ts';
import { BuildError, buildApp, mimeType, type Asset } from './build.ts';
import type { EsbuildHostInstall } from './index.ts';

let initialized: Promise<void> | null = null;

/** Starts esbuild-wasm once per page (in its own worker). */
export function initEsbuild(): Promise<void> {
  initialized ??= esbuild.initialize({ wasmURL: '/__sandburg/esbuild.wasm', worker: true });
  return initialized;
}

/** Limits concurrent requests: a package like lucide-react re-exports ~1,600 modules. */
class Pool {
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
const fetchPool = new Pool(24);

async function fetchBytes(url: string, attempts = 3): Promise<Uint8Array> {
  for (let i = 1; ; i++) {
    let res: Response | null = null;
    try {
      res = await fetch(url);
    } catch (e) {
      if (i >= attempts) throw new Error(`${url}: ${(e as Error).message}`);
    }
    if (res?.ok) return new Uint8Array(await res.arrayBuffer());
    if (res && (res.status < 500 || i >= attempts)) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 100 * i));
  }
}

/** Code files are read a directory at a time (one request per directory; see directoryPack in index.ts). */
const PACKED = /\.(m?js|cjs|json|css)$/;
const PACK_FILE_MAX = 256 * 1024;
const packs = new Map<string, Promise<Record<string, string>>>();

export async function readNodeModule(host: Pick<EsbuildHostInstall, 'key' | 'index'>, path: string): Promise<Uint8Array> {
  const rel = path.slice(1);
  if (PACKED.test(rel) && (host.index[rel] ?? Infinity) <= PACK_FILE_MAX) {
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    let pack = packs.get(`${host.key}/${dir}`);
    if (!pack) {
      pack = fetchPool.run(() => fetchBytes(`/__sandburg/nm/${host.key}/d/${encodeURI(dir)}`)).then((b) => JSON.parse(new TextDecoder().decode(b)) as Record<string, string>);
      packs.set(`${host.key}/${dir}`, pack);
      pack.catch(() => packs.delete(`${host.key}/${dir}`));
    }
    const text = (await pack)[rel.slice(dir.length + 1)];
    if (text !== undefined) return new TextEncoder().encode(text);
  }
  return fetchPool.run(() => fetchBytes(`/__sandburg/nm/${host.key}/f/${encodeURI(rel)}`));
}

/** File contents as strings or bytes (base64 entries decoded). */
export function decodeTree(tree: FileTree): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {};
  for (const [path, content] of Object.entries(tree)) {
    files[path] = typeof content === 'string' ? content : Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0));
  }
  return files;
}

/** A directory served at a URL path, like Vite's public/ or an angular.json asset entry. */
export interface StaticDir {
  /** Project-relative directory or file ("public", "src/favicon.ico"). */
  input: string;
  /** URL path it is served at ("/", "/assets"). */
  output: string;
}

export interface Site {
  assets: Map<string, Asset>;
  html: string;
  files: Record<string, string | Uint8Array>;
  statics: StaticDir[];
  /** Serve other project files at their paths too (Vite's dev server does; Angular's does not). */
  projectFiles: boolean;
}

/** Answers app requests from a build: outputs, static dirs, then index.html for anything that looks like a page (SPA routing). */
export function createResponder(site: () => Site) {
  const encode = (v: string | Uint8Array) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
  return (request: BridgedRequest, port: MessagePort) => {
    const { assets, html, files, statics, projectFiles } = site();
    const url = new URL(request.url, location.origin);
    const path = decodeURIComponent(url.pathname);
    let asset: Asset | undefined = assets.get(path);
    for (const dir of statics) {
      if (asset) break;
      const prefix = dir.output.endsWith('/') ? dir.output : `${dir.output}/`;
      const own = path === dir.output ? files[dir.input] : path.startsWith(prefix) ? files[`${dir.input}/${path.slice(prefix.length)}`] : undefined;
      if (own !== undefined) asset = { body: encode(own), type: mimeType(path) };
    }
    if (!asset && projectFiles && !path.includes('/node_modules/') && !/\.html?$/.test(path)) {
      const own = files[path.slice(1)];
      if (own !== undefined) asset = { body: encode(own), type: mimeType(path) };
    }
    if (!asset && (path === '/' || path.endsWith('.html') || !/\.[a-z0-9]+$/i.test(path))) {
      asset = { body: new TextEncoder().encode(html), type: 'text/html; charset=utf-8' };
    }
    if (!asset) {
      port.postMessage({ type: 'start', status: 404, statusText: 'Not Found', headers: [['content-type', 'text/plain']] });
      port.postMessage({ type: 'chunk', chunk: new TextEncoder().encode(`Not found: ${path}`) });
    } else {
      port.postMessage({ type: 'start', status: 200, statusText: 'OK', headers: [['content-type', asset.type], ['cache-control', 'no-cache']] });
      if (request.method !== 'HEAD') port.postMessage({ type: 'chunk', chunk: asset.body.slice() });
    }
    port.postMessage({ type: 'end' });
    port.close();
  };
}

export function createAdapter(): RuntimeAdapter {
  let files: Record<string, string | Uint8Array> = {};
  let host: EsbuildHostInstall = { key: null, index: {}, resolved: {}, lockfile: false };
  let assets = new Map<string, Asset>();
  let html = '';
  const respond = createResponder(() => ({ assets, html, files, statics: [{ input: 'public', output: '/' }], projectFiles: true }));

  return {
    name: 'esbuild',

    async mount(tree: FileTree) {
      files = decodeTree(tree);
    },

    async install(ctx: AdapterContext, hostData?: unknown): Promise<InstallReport> {
      host = (hostData as EsbuildHostInstall | undefined) ?? host;
      await initEsbuild();
      return installReport(ctx, host);
    },

    async start(ctx: AdapterContext) {
      const t = performance.now();
      try {
        const out = await buildApp(esbuild, {
          files,
          nodeModules: Object.keys(host.index).map((p) => `/${p}`),
          readNodeModule: (path) => readNodeModule(host, path),
        });
        assets = out.assets;
        html = out.html;
        for (const w of out.warnings) ctx.log('stderr', `[esbuild] ${w}`);
      } catch (e) {
        if (e instanceof BuildError) throw new AdapterError('APP', `build failed:\n${e.message}`);
        throw new AdapterError('INTERNAL', (e as Error).message);
      }
      ctx.log('stdout', `built in ${Math.round(performance.now() - t)} ms (${assets.size} files)`);
      await connectServiceWorker(respond);
      return { url: '/' };
    },

    async dispose() {},
  };
}

export function installReport(ctx: AdapterContext, host: { lockfile: boolean; resolved: Record<string, string> }): InstallReport {
  const deps = Object.keys(ctx.packageJson?.dependencies ?? {}).length + Object.keys(ctx.packageJson?.devDependencies ?? {}).length;
  return {
    resolution: host.lockfile ? 'lockfile' : deps ? 'range' : 'none',
    lockfileHonored: host.lockfile,
    dependencies: host.resolved,
    buildMs: null,
  };
}
