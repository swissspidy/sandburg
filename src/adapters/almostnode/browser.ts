/**
 * almostnode runtime adapter (browser half).
 *
 * almostnode's ViteDevServer serves files from a virtual FS and transforms
 * JSX/TS with esbuild-wasm, but it does not rewrite bare imports: they resolve
 * through an import map. `install` therefore resolves the project's direct
 * dependencies to esm.sh URLs (exact versions from package-lock.json when
 * present) and injects that import map into index.html.
 */
import { VirtualFS, ViteDevServer, getServerBridge } from 'almostnode';
import { AdapterError, type AdapterContext, type RuntimeAdapter } from '../../host/types.ts';
import type { FileTree, InstallReport } from '../../types.ts';
import { buildImportMap, injectImportMap, lockfileVersions } from './resolve.ts';

/** Virtual port of the dev server; sw.js forwards app requests to it. */
const PORT = 5173;

export function createAdapter(): RuntimeAdapter {
  let vfs: VirtualFS | null = null;
  let server: ViteDevServer | null = null;

  return {
    name: 'almostnode',

    async mount(files: FileTree) {
      vfs = new VirtualFS();
      for (const [path, content] of Object.entries(files)) {
        const abs = '/' + path;
        const dir = abs.slice(0, abs.lastIndexOf('/'));
        if (dir) vfs.mkdirSync(dir, { recursive: true });
        vfs.writeFileSync(abs, typeof content === 'string' ? content : base64ToBytes(content.base64));
      }
      if (!vfs.existsSync('/index.html')) {
        throw new AdapterError('APP', 'index.html not found at project root');
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
      if (Object.keys(resolved).length > 0) {
        const html = fs.readFileSync('/index.html', 'utf8') as string;
        if (/type\s*=\s*["']importmap["']/.test(html)) {
          ctx.log('stderr', 'index.html already has an import map; leaving it as is');
        } else {
          fs.writeFileSync('/index.html', injectImportMap(html, buildImportMap(resolved)));
        }
      }
      const names = Object.keys(resolved);
      // Honored only if every direct dependency got its locked version.
      const lockfileHonored = lock !== null && names.every((name) => name in lock);
      const resolution = names.length === 0 ? 'none' : lock ? 'lockfile' : 'range';
      return { resolution, lockfileHonored, dependencies: resolved, buildMs: null };
    },

    async start(ctx: AdapterContext) {
      const fs = requireVfs(vfs);
      server = new ViteDevServer(fs, { port: PORT, root: '/' });
      const bridge = getServerBridge();
      await bridge.initServiceWorker({ swUrl: '/__sw__.js' });
      const devServer = server;
      bridge.registerServer(
        {
          listening: true,
          address: () => ({ port: PORT, address: '0.0.0.0', family: 'IPv4' }),
          handleRequest: (method: string, url: string, headers: Record<string, string>, body?: unknown) =>
            devServer.handleRequest(method, url, headers, body as never),
        },
        PORT,
      );
      server.start();
      ctx.log('stdout', `almostnode ViteDevServer listening on virtual port ${PORT}`);
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
