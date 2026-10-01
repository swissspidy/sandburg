/**
 * The runtime's compiler (compile.ts) on esbuild's WebAssembly build, as one script for a browser:
 * the page's compile worker (compile-worker.ts, served by the host) and the demo site's service
 * worker (pages/compile.ts). esbuild's WebAssembly binary goes next to it.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const ESBUILD_WASM = createRequire(import.meta.url).resolve('esbuild-wasm/esbuild.wasm');

const bundles = new Map<string, Promise<string>>();

export function bundleBrowserCompiler(entry: string): Promise<string> {
  let bundled = bundles.get(entry);
  if (!bundled) {
    bundled = esbuild
      .build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        write: false,
        logLevel: 'warning',
        plugins: [
          {
            // The host's synchronous path (native esbuild, a cache hashed with node:crypto) is not used here.
            name: 'host-only',
            setup(b) {
              b.onResolve({ filter: /^(node:crypto|esbuild)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
              b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
                contents:
                  a.path === 'esbuild'
                    ? 'export const transformSync = () => { throw new Error("no synchronous esbuild in the browser"); };'
                    : 'export const createHash = () => { throw new Error("no node:crypto in the browser"); };',
              }));
            },
          },
        ],
      })
      .then((r) => r.outputFiles[0].text);
    bundles.set(entry, bundled);
  }
  return bundled;
}

export const COMPILE_WORKER = fileURLToPath(new URL('./compile-worker.ts', import.meta.url));
