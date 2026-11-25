/**
 * Builds Sandburg's browser runtime as static files (`sandburg/browser-runtime`, ADR 0074): what a page
 * needs to run a project in the browser without a Sandburg host. `npm run build` writes it to
 * dist/browser-runtime; the demo site (scripts/pages/build.ts) writes the same files into its root.
 *
 *   node scripts/browser-runtime.ts [--out dist/browser-runtime]
 *
 * The directory holds:
 *   index.js              the embedder's API (src/browser-runtime/index.ts), bundled; its declarations
 *                         (index.d.ts) are tsc's, from tsconfig.build.json
 *   sw.js                 the service worker an embedder registers (src/browser-runtime/sw.js)
 *   sw-core.js            the node runtime's service worker, which sw.js imports
 *   compile.js            the compiler for the service worker, on esbuild's WebAssembly build
 *   host.js               the host page's script (window.__sandburg)
 *   frame-guard.js, isolation.js  helpers for the embedding page (also in index.js)
 *   runtime/              the runtime's own files, which sw.js serves: its worker, libraries, the
 *                         page's compile and install workers, esbuild's and SQLite's WebAssembly,
 *                         the WebSocket shim
 */
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { bundleBrowserCompiler, COMPILE_WORKER, ESBUILD_WASM, INSTALL_WORKER } from '../src/adapters/node/compile-wasm-bundle.ts';
import { node } from '../src/adapters/node/index.ts';
import { bundleNodeRuntime, bundleRuntimeLib, bundleSqlite, SPARE_SCRIPT, SQLITE_WASM } from '../src/node-runtime/bundle.ts';
import { RUNTIME_LIBS, type RuntimeLib } from '../src/node-runtime/libs.ts';
import { bundleHost } from '../src/orchestrator/host-server.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(ROOT, 'src/browser-runtime');

export interface BuildOptions {
  /** Write sw.js, the embedder's service worker (the demo site has its own). Default true. */
  serviceWorker?: boolean;
  /** Write index.js, the embedder's API (tsc writes its declarations). Default true. */
  api?: boolean;
}

/** Writes the browser runtime's files into `out`. */
export async function buildBrowserRuntime(out: string, options: BuildOptions = {}): Promise<void> {
  const runtime = join(out, 'runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(out, 'host.js'), await bundleHost(node));
  await cp(join(ROOT, 'src/adapters/node/sw.js'), join(out, 'sw-core.js'));
  await writeFile(join(out, 'compile.js'), await bundleBrowserCompiler(join(SRC, 'compile.ts')));
  for (const file of ['frame-guard.js', 'isolation.js']) await cp(join(SRC, file), join(out, file));
  if (options.serviceWorker !== false) await cp(join(SRC, 'sw.js'), join(out, 'sw.js'));

  await writeFile(join(runtime, 'node-worker.js'), await bundleNodeRuntime());
  await writeFile(join(runtime, 'node-spare.js'), SPARE_SCRIPT);
  for (const name of Object.keys(RUNTIME_LIBS) as RuntimeLib[]) await writeFile(join(runtime, `node-${name}.js`), await bundleRuntimeLib(name));
  await writeFile(join(runtime, 'compile-worker.js'), await bundleBrowserCompiler(COMPILE_WORKER));
  await writeFile(join(runtime, 'install-worker.js'), await bundleBrowserCompiler(INSTALL_WORKER));
  await writeFile(join(runtime, 'sqlite3.js'), await bundleSqlite());
  await cp(ESBUILD_WASM, join(runtime, 'esbuild.wasm'));
  await cp(SQLITE_WASM, join(runtime, 'sqlite3.wasm'));
  await cp(join(ROOT, 'src/adapters/node/ws-shim.js'), join(runtime, 'ws-shim.js'));

  if (options.api !== false) {
    await esbuild.build({
      entryPoints: [join(SRC, 'index.ts')],
      outfile: join(out, 'index.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'warning',
    });
    // The helpers' declarations, which index.d.ts imports.
    for (const file of ['frame-guard.d.ts', 'isolation.d.ts']) await cp(join(SRC, file), join(out, file));
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'dist/browser-runtime' } } });
  const out = resolve(values.out);
  await buildBrowserRuntime(out);
  console.log(`browser runtime: ${out}`);
}
