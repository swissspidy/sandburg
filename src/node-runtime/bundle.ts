/** Builds the runtime worker bundle (served by the host as a module, /__sandburg/runtime/<digest>.mjs, which /__sandburg/node-worker.js imports: runtime-module.ts). */
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cachedBuild } from './bundle-cache.ts';
import { dirname, join, relative, sep } from 'node:path';
import { source } from '../sources.ts';
import { LIBS_KEY, MODULES_KEY, RUNTIME_LIBS, type RuntimeLib } from './libs.ts';
import { SPARE_NAME, SPARE_WAKE } from './names.ts';

const here = (p: string) => source(`node-runtime/${p}`);

/**
 * A spare evaluates the runtime only when it is woken or a thread takes it. Evaluating the bundle
 * costs a runtime 150-250 ms of CPU, and most programs that could start a thread (Vite loads
 * esbuild, which loads worker_threads; rollup comes with a napi-rs WebAssembly build) start none. A
 * spare compiles the script and waits; its first message loads the script again to run it, and is
 * handed on unless it was the wake-up. The runtime stays an immediately invoked function, which V8
 * compiles at once: wrapping it in a function to call later had every runtime parse it twice.
 */
const SPARE_BANNER = `"use strict";
if (self.name === ${JSON.stringify(SPARE_NAME)} && !self.__sandburgSpareTaken) {
  self.addEventListener('message', function first(e) {
    self.removeEventListener('message', first);
    self.__sandburgSpareTaken = true;
    importScripts(location.href);
    if (!e.data || e.data.type !== ${JSON.stringify(SPARE_WAKE)}) self.dispatchEvent(new MessageEvent('message', { data: e.data, ports: e.ports }));
  });
} else {`;
/**
 * What a spare runtime loads (/__sandburg/node-spare.js): nothing of the runtime until it is woken or
 * a thread takes it, when it loads the runtime's script, once, and runs it. Starting a spare on the
 * runtime's own script cost ~140 ms of CPU in a busy tab (compiling 0.86 MB), and a woken spare
 * compiled it again to run it; spares now cost so little that a run can start them before it knows
 * whether its program starts threads. Its first message is handed on unless it was the wake-up. A
 * host that serves the runtime's script with SPARE_BANNER as a spare's (it answers node-spare.js with
 * node-worker.js) gets the behaviour from before.
 */
export const SPARE_SCRIPT = `"use strict";
self.addEventListener('message', function first(e) {
  self.removeEventListener('message', first);
  self.__sandburgSpareTaken = true;
  importScripts(new URL('node-worker.js', location.href).href);
  if (!e.data || e.data.type !== ${JSON.stringify(SPARE_WAKE)}) self.dispatchEvent(new MessageEvent('message', { data: e.data, ports: e.ports }));
});
`;

const require = createRequire(import.meta.url);

/** Where the bundles' module paths are relative to (their names in esbuild's CommonJS wrappers). */
const ROOT = dirname(dirname(source('index.ts')));

/** Maps the Node built-ins that polyfills require among themselves to their polyfills. */
const aliases: esbuild.Plugin = {
  name: 'process-alias',
  setup(build) {
    build.onResolve({ filter: /^process\/?$/ }, () => ({ path: here('process-alias.cjs') }));
    // Polyfills require Node built-ins among themselves; map them to their polyfills.
    const map: Record<string, string> = { stream: 'readable-stream', path: 'path-browserify', crypto: 'crypto-browserify', zlib: 'browserify-zlib', querystring: 'querystring-es3' };
    build.onResolve({ filter: /^(stream|path|crypto|zlib|querystring|buffer|events|util|assert|string_decoder|url)\/?$/ }, (args) => {
      if (args.pluginData === 'sandburg-inner') return undefined; // our own re-resolve below
      const name = args.path.replace(/\/$/, '');
      if (args.importer.includes('/src/node-runtime/') && !map[name]) return undefined;
      return build.resolve(map[name] ?? `${name}/`, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 'sandburg-inner' });
    });
  },
};

/**
 * esbuild's CommonJS wrapper, as it opens each module of the runtime's script, with the module's path.
 * The runtime's script registers each module under its path, so that a library's script uses the
 * same instances (Buffer, streams, inherits, …) where it requires the same files.
 */
const COMMONJS_HELPER = /^ {2}var __commonJS = \(cb, mod\) => function __require\d*\(\) \{$/m;
const COMMONJS_MODULE = /__commonJS\(\{\n\s*"([^"]+)"\(/g;
const REGISTER = `  var __commonJSUnshared = __commonJS, __sandburgModules = globalThis[Symbol.for(${JSON.stringify(MODULES_KEY)})] = Object.create(null);
  __commonJS = (cb, mod) => __sandburgModules[__getOwnPropNames(cb)[0]] = __commonJSUnshared(cb, mod);
`;

let cached: Promise<string> | null = null;

/**
 * What a build's output depends on besides the files it reads: this module (the builds' options,
 * plugins and post-processing) and the libraries' table.
 */
const BUILD_SALT = [import.meta.url, here('libs.ts')].map((u) => readFileSync(u.startsWith('file:') ? fileURLToPath(u) : u, 'utf8')).join('\0');

export function bundleNodeRuntime(): Promise<string> {
  cached ??= cachedBuild('node-worker', BUILD_SALT, ROOT, () => esbuild
    .build({
      entryPoints: [here('worker.ts')],
      metafile: true,
      absWorkingDir: ROOT,
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
      inject: [here('globals-shim.ts')],
      banner: { js: SPARE_BANNER },
      footer: { js: '}' },
      // The host's esbuild, which answers the runtime's transforms (native-transform.ts).
      define: { global: 'globalThis', __SANDBURG_ESBUILD__: JSON.stringify(esbuild.version) },
      plugins: [
        {
          name: 'runtime-libs',
          setup(build) {
            // The libraries are their own scripts: their packages must not end up in this one.
            const names = Object.values(RUNTIME_LIBS).map((n) => n.replace(/[/.]/g, '\\$&'));
            build.onResolve({ filter: new RegExp(`^(${names.join('|')})/?$`) }, (args) => ({ errors: [{ text: `${args.path} is a runtime library (RUNTIME_LIBS): load it with runtimeLib()` }] }));
          },
        },
        aliases,
      ],
    }), (text) => {
      const helper = COMMONJS_HELPER.exec(text);
      const end = helper ? text.indexOf('\n  };\n', helper.index) : -1;
      if (end < 0) throw new Error("bundleNodeRuntime: esbuild's __commonJS helper changed; update COMMONJS_HELPER");
      return text.slice(0, end + 6) + REGISTER + text.slice(end + 6);
    });
  cached.catch(() => (cached = null));
  return cached;
}

const libs = new Map<RuntimeLib, Promise<string>>();

/** Each library's script: what the runtime takes from the package. */
const LIB_ENTRY: Record<RuntimeLib, (libs: string) => string> = {
  crypto: (libs) => `(${libs} ??= {}).crypto = require(${JSON.stringify(RUNTIME_LIBS.crypto)});`,
  zlib: (libs) => `(${libs} ??= {}).zlib = require(${JSON.stringify(RUNTIME_LIBS.zlib)});`,
  // napi-rs' runtime re-exports WASI from @tybys/wasm-util; the rest of it is emnapi, which node:wasi does not use.
  wasi: (libs) => `import { WASI } from '@tybys/wasm-util';\n(${libs} ??= {}).wasi = { WASI };`,
};
/** Where a library's entry resolves its imports from: wasi's from napi-rs' runtime, as the runtime would. */
const libDir = (name: RuntimeLib) => (name === 'wasi' ? dirname(require.resolve(RUNTIME_LIBS.wasi)) : here('.'));

/**
 * A runtime library's script (see RUNTIME_LIBS): it sets globalThis[Symbol.for(LIBS_KEY)][name] to the
 * package's exports. A file that the runtime's script has as a CommonJS module is taken from there
 * (MODULES_KEY), so both see one Buffer class, one stream module, and so on, as in one script.
 */
export function bundleRuntimeLib(name: RuntimeLib): Promise<string> {
  let lib = libs.get(name);
  if (!lib) {
    lib = bundleNodeRuntime().then(async (runtime) => {
      const shared = new Set([...runtime.matchAll(COMMONJS_MODULE)].map((m) => m[1]));
      const key = (k: string) => `globalThis[Symbol.for(${JSON.stringify(k)})]`;
      const salt = `${BUILD_SALT}\0${name}\0${createHash('sha256').update(runtime).digest('hex')}`;
      return cachedBuild(`node-${name}`, salt, ROOT, () => esbuild.build({
        metafile: true,
        stdin: { contents: LIB_ENTRY[name](key(LIBS_KEY)), resolveDir: libDir(name), sourcefile: `node-${name}.js` },
        absWorkingDir: ROOT,
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent',
        // Free Buffer and process, as in the runtime's script (globals-shim.ts), from its modules.
        inject: [here('lib-globals.js')],
        define: { global: 'globalThis' },
        plugins: [
          {
            name: 'runtime-modules',
            setup(build) {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData === 'runtime-modules' || args.pluginData === 'sandburg-inner' || args.kind === 'entry-point') return undefined;
                const r = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: 'runtime-modules' });
                if (r.errors.length) return undefined; // esbuild's own answer (a require in a try block may fail)
                const path = relative(ROOT, r.path).split(sep).join('/');
                return shared.has(path) ? { path, namespace: 'runtime-module' } : r;
              });
              build.onLoad({ filter: /.*/, namespace: 'runtime-module' }, (args) => ({ contents: `module.exports = ${key(MODULES_KEY)}[${JSON.stringify(args.path)}]();`, loader: 'js' }));
            },
          },
          aliases,
        ],
      }));
    });
    libs.set(name, lib);
    lib.catch(() => libs.delete(name));
  }
  return lib;
}

/** The official SQLite WebAssembly build (Apache-2.0), loaded by the runtime with importScripts when an app uses SQLite. */
export const SQLITE_WASM = require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');

let sqliteBundle: Promise<string> | null = null;

export function bundleSqlite(): Promise<string> {
  sqliteBundle ??= esbuild
    .build({
      entryPoints: [join(dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')), 'dist/index.mjs')],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'sandburgSqlite3',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
      // The module locates its .wasm relative to itself; the runtime passes locateFile instead.
      define: { 'import.meta.url': '"http://sandburg.invalid/__sandburg/sqlite3.js"' },
    })
    .then((r) => r.outputFiles[0].text);
  sqliteBundle.catch(() => (sqliteBundle = null));
  return sqliteBundle;
}
