/**
 * almostnode runtime adapter (browser half).
 *
 * Vite: almostnode's ViteDevServer serves files from a virtual FS and
 * transforms JSX/TS with esbuild-wasm, but it does not rewrite bare imports:
 * they resolve through an import map. `install` therefore resolves the
 * project's direct dependencies to esm.sh URLs (exact versions from
 * package-lock.json when present) and injects that import map into index.html.
 *
 * Next.js: NextDevServer rewrites bare imports to esm.sh itself and renders
 * pages client-side; it pins React 18.2.0 in its own import map, which the
 * resolved versions override (later import-map keys win).
 */
import { NextDevServer, VirtualFS, ViteDevServer, getServerBridge } from 'almostnode';
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import { NEXT_SHIM_FILES } from './next-shims.ts';
import { buildImportMap, injectImportMap, lockfileVersions, nextImportMap, unpinReact } from './resolve.ts';

/** Virtual port of the dev server; sw.js forwards app requests to it. */
const PORT = 5173;

export function createAdapter(): RuntimeAdapter {
  let vfs: VirtualFS | null = null;
  let server: ViteDevServer | NextDevServer | null = null;
  let importMap: Record<string, string> = {};

  return {
    name: 'almostnode',

    async mount(files: FileTree, ctx: AdapterContext) {
      vfs = new VirtualFS();
      for (const [path, content] of Object.entries(files)) {
        const abs = '/' + path;
        const dir = abs.slice(0, abs.lastIndexOf('/'));
        if (dir) vfs.mkdirSync(dir, { recursive: true });
        vfs.writeFileSync(abs, typeof content === 'string' ? content : base64ToBytes(content.base64));
      }
      if (ctx.framework === 'vite' && !vfs.existsSync('/index.html')) {
        throw new AdapterError('APP', 'index.html not found at project root');
      }
      if (ctx.framework === 'next' && !vfs.existsSync('/app') && !vfs.existsSync('/pages') && !vfs.existsSync('/src/app') && !vfs.existsSync('/src/pages')) {
        throw new AdapterError('APP', 'no app/ or pages/ directory');
      }
    },

    async install(ctx: AdapterContext): Promise<InstallReport> {
      const fs = requireVfs(vfs);
      const deps = ctx.packageJson?.dependencies ?? {};
      const lock = readLockfile(fs);
      const resolved: Record<string, string> = {};
      for (const [name, range] of Object.entries(deps)) {
        if (/^(file|link|workspace|git\+?|https?):/.test(range)) {
          throw new AdapterError('UNSUPPORTED', `dependency ${name}@${range}: only registry dependencies are supported`);
        }
        resolved[name] = lock?.[name] ?? range;
      }
      importMap = ctx.framework === 'next' ? nextImportMap(pickSingletons(resolved, 'next')).imports : buildImportMap(resolved).imports;
      if (ctx.framework === 'vite' && Object.keys(resolved).length > 0) {
        const html = fs.readFileSync('/index.html', 'utf8') as string;
        if (/type\s*=\s*["']importmap["']/.test(html)) {
          ctx.log('stderr', 'index.html already has an import map; leaving it as is');
        } else {
          fs.writeFileSync('/index.html', injectImportMap(html, buildImportMap(resolved)));
        }
      }
      const shims: string[] = [];
      if (ctx.framework === 'next' && !fs.existsSync('/node_modules/next/server.js')) {
        for (const [path, content] of Object.entries(NEXT_SHIM_FILES)) {
          fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
          fs.writeFileSync(path, content);
        }
        shims.push('next/server');
      }
      const names = Object.keys(resolved);
      // Honored only if every direct dependency got its locked version.
      const lockfileHonored = lock !== null && names.every((name) => name in lock);
      const resolution = names.length === 0 ? 'none' : lock ? 'lockfile' : 'range';
      return { resolution, lockfileHonored, dependencies: resolved, buildMs: null, shims };
    },

    async start(ctx: AdapterContext) {
      const fs = requireVfs(vfs);
      if (ctx.framework === 'next') {
        const srcDir = !fs.existsSync('/app') && !fs.existsSync('/pages') && fs.existsSync('/src') ? '/src' : '';
        server = new NextDevServer(fs, {
          port: PORT,
          root: '/',
          appDir: `${srcDir}/app`,
          pagesDir: `${srcDir}/pages`,
          preferAppRouter: fs.existsSync(`${srcDir}/app`),
          additionalImportMap: importMap,
        });
      } else {
        server = new ViteDevServer(fs, { port: PORT, root: '/' });
      }
      const bridge = getServerBridge();
      await bridge.initServiceWorker({ swUrl: '/__sw__.js' });
      const devServer = server;
      // Only needed when the project declares React; otherwise almostnode's pinned React is all there is.
      const overrideReact = 'react' in importMap;
      bridge.registerServer(
        {
          listening: true,
          address: () => ({ port: PORT, address: '0.0.0.0', family: 'IPv4' }),
          handleRequest: async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
            const res = await devServer.handleRequest(method, url, headers, body as never);
            return overrideReact ? unpinResponse(res) : res;
          },
          // Next.js API routes can stream; the bridge uses this when present.
          ...(devServer instanceof NextDevServer
            ? { handleStreamingRequest: devServer.handleStreamingRequest.bind(devServer) }
            : {}),
        } as never,
        PORT,
      );
      server.start();
      ctx.log('stdout', `almostnode ${server.constructor.name} listening on virtual port ${PORT}`);
      return { url: `/__virtual__/${PORT}/` };
    },

    async ready() {
      const res = await fetch(`/__virtual__/${PORT}/`);
      if (!res.ok) throw new AdapterError('INTERNAL', `dev server answered ${res.status} for /`);
    },

    async dispose() {
      server?.stop();
      getServerBridge().unregisterServer(PORT);
      server = null;
      vfs = null;
    },
  };
}

type DevResponse = Awaited<ReturnType<ViteDevServer['handleRequest']>>;

function unpinResponse(res: DevResponse): DevResponse {
  const type = Object.entries(res.headers as Record<string, string>).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (!/javascript|html/.test(type)) return res;
  const text = new TextDecoder().decode(res.body as unknown as Uint8Array);
  const patched = unpinReact(text);
  if (patched === text) return res;
  const body = new TextEncoder().encode(patched);
  const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
  return { ...res, headers, body: body as unknown as DevResponse['body'] };
}

/**
 * Next.js: NextDevServer maps every other package to esm.sh on its own, so the
 * import map only needs to override its pinned React. Vite needs every package.
 */
function pickSingletons(resolved: Record<string, string>, framework: string): Record<string, string> {
  if (framework !== 'next') return resolved;
  return Object.fromEntries(Object.entries(resolved).filter(([name]) => name === 'react' || name === 'react-dom'));
}

function requireVfs(vfs: VirtualFS | null): VirtualFS {
  if (!vfs) throw new AdapterError('INTERNAL', 'mount() has not run');
  return vfs;
}

/** Exact versions from package-lock.json, or null when absent or v1. */
function readLockfile(vfs: VirtualFS): Record<string, string> | null {
  if (!vfs.existsSync('/package-lock.json')) return null;
  try {
    return lockfileVersions(vfs.readFileSync('/package-lock.json', 'utf8') as string);
  } catch {
    throw new AdapterError('APP', 'package-lock.json is not valid JSON');
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
