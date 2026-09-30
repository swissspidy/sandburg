/**
 * node runtime adapter (Node half): Sandburg's own Node.js runtime for the
 * browser (ADR 0006). Dependencies are installed on the host with npm
 * (--ignore-scripts: no package code runs outside the browser) and served
 * lazily; the app itself, Next.js included, runs in a Web Worker.
 */
import { fileURLToPath } from 'node:url';
import { bundleNodeRuntime, bundleSqlite, SQLITE_WASM } from '../../node-runtime/bundle.ts';
import { readFile } from 'node:fs/promises';
import { NODE_VERSION } from '../../node-runtime/version.ts';
import type { AdapterDescriptor, HostRequest, HostResponse, Project } from '../../types.ts';
import { compileForRuntime, projectHasTopLevelAwait, type CompileKind } from './compile.ts';
import { sharedInstaller } from './install.ts';
import type { HostInstall } from './browser.ts';

const installer = sharedInstaller();
const WS_SHIM = fileURLToPath(new URL('./ws-shim.js', import.meta.url));

/** Extra packages a framework needs in the browser: WebAssembly builds of native tools. */
function extraDependencies(project: Project): Record<string, string> {
  const next = project.packageJson?.dependencies?.next ?? project.packageJson?.devDependencies?.next;
  // SWC's official WebAssembly build replaces the native @next/swc-* binaries (omitted at install).
  return typeof next === 'string' ? { '@next/swc-wasm-nodejs': next } : {};
}

export async function serve(req: HostRequest): Promise<HostResponse | null> {
  if (req.path === '/__sandburg/node-worker.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await bundleNodeRuntime() };
  }
  if (req.path === '/__sandburg/ws-shim.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await readFile(WS_SHIM) };
  }
  if (req.path === '/__sandburg/sqlite3.js') {
    return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: await bundleSqlite() };
  }
  if (req.path === '/__sandburg/sqlite3.wasm') {
    return { status: 200, headers: { 'content-type': 'application/wasm', 'cache-control': 'max-age=31536000, immutable' }, body: await readFile(SQLITE_WASM) };
  }
  if (req.path === '/__sandburg/tla-scan' && req.method === 'POST') {
    const files = JSON.parse((await req.body()).toString('utf8')) as Record<string, string>;
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topLevelAwait: projectHasTopLevelAwait(files) }) };
  }
  if (req.path === '/__sandburg/compile' && req.method === 'POST') {
    const kind = (req.query.get('kind') ?? 'cjs') as CompileKind;
    try {
      return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: compileForRuntime((await req.body()).toString('utf8'), req.query.get('path') ?? '/unknown.js', kind, { asyncModules: req.query.get('async') === '1' }) };
    } catch (e) {
      return { status: 400, headers: { 'content-type': 'text/plain' }, body: String((e as Error).message) };
    }
  }
  const m = /^\/__sandburg\/nm\/([0-9a-f]{24})\/(f|t)\/(.+)$/.exec(req.path);
  if (m) {
    const [, key, mode, rel] = m;
    const file = mode === 't' ? await installer.file(key, decodeURIComponent(rel)) : await installer.raw(key, decodeURIComponent(rel));
    return file ? { status: 200, headers: { 'content-type': file.type, 'cache-control': 'max-age=31536000, immutable' }, body: file.body } : null;
  }
  return null;
}

export const node: AdapterDescriptor = {
  name: 'node',
  version: NODE_VERSION,
  browserEntry: fileURLToPath(new URL('./browser.ts', import.meta.url)),
  assets: { '/__sw__.js': fileURLToPath(new URL('./sw.js', import.meta.url)) },
  // The app's own server-side fetches (e.g. next/font/google) go through the gateway.
  egress: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  crossOriginIsolation: false,
  // A cold npm install of a Next.js app and its first webpack compile take a while.
  // expect: routes compile on first request (next dev), which is slower in the browser.
  timeouts: { install: 600_000, start: 180_000, ready: 240_000, check: 60_000, expect: 20_000 },
  probe(project: Project) {
    if (project.framework === 'next') return { verdict: 'supported' };
    if (project.framework === 'vite') {
      return { verdict: 'unsupported', reason: 'real Vite needs its native esbuild and Rollup builds swapped for wasm; not yet supported by the node runtime (use almostnode)' };
    }
    const scripts = project.packageJson?.scripts ?? {};
    if (/^node\s+\S+/.test(scripts.dev ?? scripts.start ?? '') || typeof project.packageJson?.main === 'string') return { verdict: 'supported' };
    return { verdict: 'unsupported', reason: 'no dev/start script of the form "node <file>" and no "main"' };
  },
  async hostInstall(project, log): Promise<HostInstall> {
    const info = await installer.install(project, extraDependencies(project), log);
    return { key: info.key, index: await installer.index(info.key), resolved: info.resolved, lockfile: info.lockfile };
  },
  serve,
};
