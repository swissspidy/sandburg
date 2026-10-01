/**
 * What an install changes in the packages it installs, for the browser runtime: shared by the host's
 * installer (install.ts, npm) and the browser's (node-runtime/npm/install.ts). Browser-safe: data
 * and strings only.
 */
import type { Project } from '../../types.ts';

/** Packages installed beside the project's own. */
export function extraDependencies(project: Pick<Project, 'packageJson'>): Record<string, string> {
  const next = project.packageJson?.dependencies?.next ?? project.packageJson?.devDependencies?.next;
  // SWC's official WebAssembly build replaces the native @next/swc-* binaries (omitted at install).
  return typeof next === 'string' ? { '@next/swc-wasm-nodejs': next } : {};
}

/** Where Next.js looks for SWC's WebAssembly build (NEXT_TEST_WASM): a copy of @next/swc-wasm-nodejs. */
export const NEXT_SWC_WASM = { from: 'node_modules/@next/swc-wasm-nodejs', to: 'node_modules/next/wasm/@next/swc-wasm-nodejs' };

/**
 * napi-rs packages publish their WebAssembly build as an optional dependency named <name>-wasm32-wasi,
 * or publish one beside their native builds (<name>-linux-x64-gnu) without listing it: the bindings
 * an install adds, from a package's optionalDependencies (name -> [binding, range]).
 */
export function wasiBindings(optionalDependencies: Record<string, string> | undefined): { listed: Record<string, string>; candidates: Record<string, string> } {
  const listed: Record<string, string> = {};
  const candidates: Record<string, string> = {};
  for (const [name, range] of Object.entries(optionalDependencies ?? {})) {
    if (/wasm32-wasi$/.test(name)) listed[name] = range;
    else if (/-linux-x64-gnu$/.test(name)) candidates[name.replace(/-linux-x64-gnu$/, '-wasm32-wasi')] = range;
  }
  return { listed, candidates };
}

/**
 * Packages whose native code has a WebAssembly build of the same version with the same API. Each
 * installed copy gets that build installed next to it (in its own node_modules), and the file that
 * loads the native code is replaced by one that loads the WebAssembly build.
 */
export const WASM_BUILDS: { name: string; wasm: string; file: string; applies(version: string): boolean; shim: string; also?: Record<string, string> }[] = [
  {
    // The Dart Sass compiler as a native program (sass-embedded-<platform>, which it runs over a pipe):
    // the same compiler compiled to JavaScript (sass), with the same API. Angular's CLI and Vite
    // prefer sass-embedded when it is installed.
    name: 'sass-embedded',
    wasm: 'sass',
    file: 'dist/lib/index.js',
    applies: (v) => /^1\./.test(v),
    shim: "// sandburg: Dart Sass compiled to JavaScript (sass) in place of the native embedded compiler\nmodule.exports = require('../../node_modules/sass/sass.node.js');\n",
    also: {
      'dist/lib/index.mjs': "// sandburg: Dart Sass compiled to JavaScript (sass) in place of the native embedded compiler\nexport * from '../../node_modules/sass/sass.node.mjs';\nexport { default } from '../../node_modules/sass/sass.node.mjs';\n",
    },
  },
  {
    // Rollup 4's parser (@rollup/rollup-<platform>).
    name: 'rollup',
    wasm: '@rollup/wasm-node',
    file: 'dist/native.js',
    applies: (v) => /^4\./.test(v),
    shim: "// sandburg: rollup's WebAssembly build (@rollup/wasm-node)\nmodule.exports = require('../node_modules/@rollup/wasm-node/dist/native.js');\n",
  },
  {
    // lightningcss's native parser (lightningcss-<platform>): Tailwind CSS v4, Vite's CSS minifier.
    name: 'lightningcss',
    wasm: 'lightningcss-wasm',
    file: 'node/index.js',
    applies: (v) => /^1\./.test(v),
    shim: "// sandburg: lightningcss's WebAssembly build (lightningcss-wasm), loaded synchronously\nmodule.exports = require('../node_modules/lightningcss-wasm/wasm-node.cjs');\n",
  },
  {
    // esbuild's Go binary (@esbuild/<platform>): its browser build, which runs the compiler in this thread.
    name: 'esbuild',
    wasm: 'esbuild-wasm',
    file: 'lib/main.js',
    applies: (v) => /^0\.(1[89]|[2-9]\d)\./.test(v),
    shim: `// sandburg: esbuild's WebAssembly build (esbuild-wasm). The synchronous API needs a separate thread and is unavailable.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '../node_modules/esbuild-wasm');
// Its in-thread service reads the worker global \`self\`, which the runtime leaves undefined (as in Node).
// Go's file system calls go to that scope's \`fs\`: the runtime's, as esbuild-wasm has under Node.
// The service sets read (stdin) and writeSync (stdout, stderr) on it for its pipes: those take the
// pipes' descriptors, the file system keeps the rest. Go writes with fs.write, which goes to writeSync
// for the pipes (as in esbuild-wasm's own stub fs).
const scopeFs = Object.create(fs);
const pipes = { read: null, writeSync: null };
Object.defineProperty(scopeFs, 'read', {
  get: () => (fd, ...rest) => (fd === 0 && pipes.read ? pipes.read(fd, ...rest) : fs.read(fd, ...rest)),
  set: (fn) => (pipes.read = fn),
});
Object.defineProperty(scopeFs, 'writeSync', {
  get: () => (fd, buf, ...rest) => ((fd === 1 || fd === 2) && pipes.writeSync ? pipes.writeSync(fd, buf) : fs.writeSync(fd, buf, ...rest)),
  set: (fn) => (pipes.writeSync = fn),
});
scopeFs.write = (fd, buf, offset, length, position, callback) => {
  if ((fd !== 1 && fd !== 2) || !pipes.writeSync) return fs.write(fd, buf, offset, length, position, callback);
  try {
    callback(null, pipes.writeSync(fd, offset === 0 && length === buf.length ? buf : buf.subarray(offset, offset + length)));
  } catch (e) {
    callback(e);
  }
};
// Other globals are read from the real global object (its getters, e.g. location, need it as receiver).
const scope = new Proxy(Object.create(globalThis, { fs: { value: scopeFs, enumerable: true } }), {
  get: (target, key) => (key === 'fs' ? scopeFs : Reflect.get(globalThis, key)),
});
const browser = { exports: {} };
new Function('self', 'module', 'exports', 'require', fs.readFileSync(path.join(dir, 'lib/browser.js'), 'utf8'))(scope, browser, browser.exports, require);
const esbuild = browser.exports;
let ready;
const init = () =>
  (ready ??= esbuild.initialize({ wasmModule: new WebAssembly.Module(fs.readFileSync(path.join(dir, 'esbuild.wasm'))), worker: false }));
const later = (name) => (...args) => init().then(() => esbuild[name](...args));
// The browser build has no file system of its own, so no \`write: true\` (the default under Node): it
// builds in memory and the output is written here, as esbuild does under Node.
const writeOutput = (result, write) => {
  if (!write || !result || !result.outputFiles) return result;
  for (const file of result.outputFiles) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.contents);
  }
  const { outputFiles, ...rest } = result;
  return rest;
};
const inMemory = (options) => ({ ...options, write: false });
const build = (options = {}) => init().then(() => esbuild.build(inMemory(options))).then((r) => writeOutput(r, options.write !== false));
const context = (options = {}) =>
  init().then(() => esbuild.context(inMemory(options))).then((ctx) => ({
    ...ctx,
    rebuild: () => ctx.rebuild().then((r) => writeOutput(r, options.write !== false)),
    watch: ctx.watch,
    serve: ctx.serve,
    cancel: ctx.cancel,
    dispose: ctx.dispose,
  }));
const sync = (name) => () => {
  throw new Error('esbuild.' + name + '() is not available in the browser runtime (esbuild-wasm has no synchronous API there); use the asynchronous API');
};
module.exports = {
  version: esbuild.version,
  build,
  context,
  transform: later('transform'),
  formatMessages: later('formatMessages'),
  analyzeMetafile: later('analyzeMetafile'),
  buildSync: sync('buildSync'),
  transformSync: sync('transformSync'),
  formatMessagesSync: sync('formatMessagesSync'),
  analyzeMetafileSync: sync('analyzeMetafileSync'),
  initialize: () => init().then(() => undefined),
  stop: () => Promise.resolve(),
};
`,
  },
];


/**
 * Changes to package sources for what the browser cannot do, or does slowly. piscina's workers wait for tasks with
 * Atomics.wait and take them with receiveMessageOnPort, which needs a synchronous look into a
 * MessagePort (browsers have none): they use its message-event mode instead, as under WebContainers.
 */
export const SOURCE_PATCHES: { file: RegExp; from: string | RegExp; to: string }[] = [
  {
    // Next.js' webpack cache: read-only unless the run keeps it (a seed run). next dev gzips its cache
    // packs as it stores them, 2.1 s of a warm run's main thread, for a cache no later run reads.
    file: /(^|\/)node_modules\/next\/dist\/build\/webpack-config\.js$/,
    from: /compression: dev \? 'gzip' : false\n/,
    to: "compression: dev ? 'gzip' : false,\n        readonly: process.env.SANDBURG_WEBPACK_CACHE_READONLY === '1' // sandburg: see SOURCE_PATCHES\n",
  },
  {
    file: /(^|\/)node_modules\/piscina\/dist\/(esm-)?worker\.m?js$/,
    from: /useAtomics = useAtomics !== false && message\.atomics !== 'disabled';/,
    to: "useAtomics = false; // sandburg: no receiveMessageOnPort in the browser runtime",
  },
  {
    // piscina 4
    file: /(^|\/)node_modules\/piscina\/dist\/src\/worker\.js$|(^|\/)node_modules\/piscina\/dist\/worker\.js$/,
    from: /useAtomics = process\.env\.PISCINA_DISABLE_ATOMICS === '1' \? false : message\.useAtomics;/,
    to: "useAtomics = false; // sandburg: no receiveMessageOnPort in the browser runtime",
  },
];

