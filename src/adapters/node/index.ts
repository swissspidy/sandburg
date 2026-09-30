/**
 * node runtime adapter (Node half): Sandburg's own Node.js runtime for the
 * browser (ADR 0006). Dependencies are installed on the host with npm
 * (--ignore-scripts: no package code runs outside the browser) and served
 * lazily; the app itself, Next.js included, runs in a Web Worker.
 */
import { fileURLToPath } from 'node:url';
import { bundleNodeRuntime, bundleSqlite, SQLITE_WASM } from '../../node-runtime/bundle.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expandScript, isTsRunner } from '../esbuild/backend.ts';
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

/**
 * How the project's dev (or start) script starts it: `node <file>` (or tsx/nodemon …), or a
 * package's CLI (vite, astro, …), following npm run / concurrently like a shell would.
 */
export function startCommand(project: Project): { file?: string; bin?: string; argv: string[]; command: string; tsRunner: boolean } | null {
  const scripts = project.packageJson?.scripts ?? {};
  const script = scripts.dev ?? scripts.start;
  if (script) {
    for (const leaf of expandScript(project.files, '', script)) {
      if (leaf.dir) continue; // another package's script: not this runtime's job
      const [cmd, ...args] = leaf.words;
      if (/^(node|nodemon|tsx|ts-node|ts-node-dev|esno)$/.test(cmd)) {
        const positional = args.filter((a) => !a.startsWith('-') && a !== 'watch');
        if (positional[0]) return { file: positional[0].replace(/^\.\//, ''), argv: positional.slice(1), command: leaf.command, tsRunner: isTsRunner(leaf.command) };
      } else if (/^[a-z@][\w@/.-]*$/i.test(cmd) && !/^(npm|npx|yarn|pnpm|bun|cd|echo|rm|cp|mkdir|concurrently|cross-env)$/.test(cmd)) {
        return { bin: cmd, argv: args, command: leaf.command, tsRunner: false };
      }
    }
  }
  if (typeof project.packageJson?.main === 'string') return { file: project.packageJson.main.replace(/^\.\//, ''), argv: [], command: `node ${project.packageJson.main}`, tsRunner: false };
  return null;
}

/** The JS file behind a package binary (node_modules/.bin/<name>), from the installed packages' "bin" fields. */
async function resolveBin(installDir: string, name: string): Promise<string | null> {
  const nm = join(installDir, 'node_modules');
  const candidates = [name, ...(await readdir(nm).catch(() => [] as string[]))];
  for (const dir of candidates) {
    const pkgs = dir.startsWith('@') ? (await readdir(join(nm, dir)).catch(() => [] as string[])).map((s) => `${dir}/${s}`) : [dir];
    for (const pkgName of pkgs) {
      try {
        const pkg = JSON.parse(await readFile(join(nm, pkgName, 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> };
        const bin = typeof pkg.bin === 'string' ? (pkg.name?.split('/').pop() === name ? pkg.bin : null) : pkg.bin?.[name];
        if (bin) return `node_modules/${pkgName}/${bin.replace(/^\.\//, '')}`;
      } catch {
        // not a package
      }
    }
  }
  return null;
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
  // The npm registry: dev servers check it for newer versions of themselves (next dev does, on every start).
  egress: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://registry.npmjs.org'],
  // WebAssembly threads (rolldown and other Rust tools' WASI builds) need shared memory.
  crossOriginIsolation: 'credentialless',
  // A cold npm install of a Next.js app and its first webpack compile take a while.
  // expect: routes compile on first request (next dev), which is slower in the browser.
  timeouts: { install: 600_000, start: 180_000, ready: 240_000, check: 60_000, expect: 20_000 },
  probe(project: Project) {
    if (project.framework === 'next') return { verdict: 'supported' };
    if (startCommand(project)) return { verdict: 'supported' };
    const scripts = project.packageJson?.scripts ?? {};
    return { verdict: 'unsupported', reason: `no way to start this project in the node runtime (dev/start script: "${scripts.dev ?? scripts.start ?? ''}")` };
  },
  async hostInstall(project, log): Promise<HostInstall> {
    const info = await installer.install(project, extraDependencies(project), log);
    const cmd = project.framework === 'next' ? null : startCommand(project);
    let start: HostInstall['start'] = null;
    if (cmd) {
      const main = cmd.bin ? await resolveBin(info.dir, cmd.bin) : cmd.file;
      if (!main) throw new Error(`the dev script runs "${cmd.bin}", which no installed package provides`);
      start = { main, argv: cmd.argv, command: cmd.command, tsRunner: cmd.tsRunner };
    }
    return { key: info.key, index: await installer.index(info.key), resolved: info.resolved, lockfile: info.lockfile, start };
  },
  serve,
};
