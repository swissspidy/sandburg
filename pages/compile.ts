/**
 * The runtime's compiler (src/adapters/node/compile.ts) on esbuild's WebAssembly build, for the demo
 * service worker: it compiles what the recording did not see (code whose content changes from run
 * to run). Bundled by scripts/pages/build.ts into compile.js; the WebAssembly loads on first use.
 */
import * as esbuild from 'esbuild-wasm';
import { compileForRuntimeAsync, type CompileKind } from '../src/adapters/node/compile.ts';

let ready: Promise<void> | null = null;

async function compile(code: string, path: string, kind: CompileKind, asyncModules: boolean, wasmURL: string): Promise<string> {
  // A service worker cannot start workers: esbuild runs in it.
  // A failed start (esbuild.wasm did not download) is tried again by the next compile.
  ready ??= esbuild.initialize({ wasmURL, worker: false }).catch((e: unknown) => {
    ready = null;
    throw e;
  });
  await ready;
  return compileForRuntimeAsync(code, path, kind, { asyncModules }, async (c, options) => (await esbuild.transform(c, options)).code);
}

(self as unknown as { sandburgCompile: typeof compile }).sandburgCompile = compile;
