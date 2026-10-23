/**
 * Polyfills of built-ins that few runtimes load, left out of the runtime's script: each is a script
 * of its own (/__sandburg/node-<name>.js), which a runtime loads with importScripts the first time a
 * program requires the built-in (runtimeLib in worker.ts). Every runtime compiles its whole script
 * (a worker's script gets no code cache), and every thread and spare is a runtime: these were 1.7
 * of its 2.8 MB, and node:crypto's was evaluated in each.
 */
export const RUNTIME_LIBS = { crypto: 'crypto-browserify', wasi: '@napi-rs/wasm-runtime' } as const;
export type RuntimeLib = keyof typeof RUNTIME_LIBS;
/** Where a loaded library puts its exports, and where the runtime's script keeps its CommonJS modules by path. */
export const LIBS_KEY = 'sandburg.libs';
export const MODULES_KEY = 'sandburg.modules';
