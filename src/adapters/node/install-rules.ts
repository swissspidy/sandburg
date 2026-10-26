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
 * TypeScript 7's lib/tsc.js in the browser runtime (see WASM_BUILDS). `tsc --showConfig` prints the
 * project's configuration with `extends` applied: compilerOptions merged (a later config wins), path
 * options relative to the project's config, inherited files, include and exclude prefixed with their
 * config's directory, enum values in lower case, `plugins` left out, as tsc prints them. Options tsc
 * derives from others (preserveConstEnums from isolatedModules, ...) are not added, and `files` is
 * not expanded to the files include matches.
 */
export const TSC_SHIM = `// sandburg: TypeScript 7's native compiler cannot run in the browser runtime (see install-rules.ts)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const PATH_OPTIONS = new Set(['baseUrl', 'rootDir', 'outDir', 'declarationDir', 'outFile', 'tsBuildInfoFile', 'rootDirs', 'typeRoots']);
const ENUM_OPTIONS = new Set(['target', 'module', 'moduleResolution', 'moduleDetection', 'jsx', 'newLine', 'importsNotUsedAsValues']);

const args = process.argv.slice(2);
if (args.includes('--showConfig')) {
  const at = Math.max(args.indexOf('--project'), args.indexOf('-p'));
  const project = path.resolve(at >= 0 ? args[at + 1] : '.');
  const file = fs.statSync(project).isDirectory() ? path.join(project, 'tsconfig.json') : project;
  const config = showConfig(file, new Set(), path.dirname(file));
  delete config.compilerOptions.plugins;
  process.stdout.write(JSON.stringify(config, null, 4) + '\\n');
  // Done, as tsc is: a process that only ends once its event loop has stayed idle a while ends
  // 0.2 s later (next dev waits for this one as it starts).
  process.exit(0);
} else {
  // On this thread, as tsrs runs under Bun: its Node entry point starts a worker thread for a larger
  // stack, which the runtime does not give one, and the worker kept the process alive. Output is
  // collected and written through process.stdout (a worker has no descriptors 1 and 2 here).
  try {
    const { loadModule } = await import('../node_modules/@tsrs/wasm/node.js');
    const { run } = await import('../node_modules/@tsrs/wasm/node-run.js');
    const result = run(loadModule(), { args, env: process.env, tty: Boolean(process.stdout.isTTY), stdout: 'collect', stderr: 'collect' });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (e) {
    process.stderr.write('tsc (tsrs): ' + (e && e.stack ? e.stack : String(e)) + '\\n');
    process.exitCode = 1;
  }
}

// JSON with comments and trailing commas.
function parse(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\\\]|\\\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      if (!m) throw new SyntaxError('unterminated string in tsconfig');
      out += m[0];
      i += m[0].length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\\n') i++;
      out += '\\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new SyntaxError('unterminated comment in tsconfig');
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\\s*[}\\]])/g, '$1'));
}

function resolveExtends(spec, dir) {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const file = path.resolve(dir, spec);
    return fs.existsSync(file) || file.endsWith('.json') ? file : file + '.json';
  }
  const require = createRequire(path.join(dir, 'tsconfig.json'));
  try {
    return require.resolve(spec);
  } catch {
    return require.resolve(spec + '/tsconfig.json');
  }
}

function showConfig(file, seen, rootDir) {
  if (seen.has(file)) throw new Error('circularity detected while resolving configuration: ' + file);
  seen.add(file);
  const config = parse(fs.readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  let merged = { compilerOptions: {} };
  for (const spec of [config.extends ?? []].flat()) {
    const base = showConfig(resolveExtends(spec, dir), new Set(seen), rootDir);
    merged = { ...merged, ...base, compilerOptions: { ...merged.compilerOptions, ...base.compilerOptions } };
  }
  const relative = (value) => {
    if (typeof value !== 'string') return value;
    const absolute = value.startsWith('\${configDir}') ? path.join(rootDir, value.slice('\${configDir}'.length)) : path.resolve(dir, value);
    const rel = path.relative(rootDir, absolute).split(path.sep).join('/');
    return rel === '' ? './' : rel.startsWith('.') ? rel : './' + rel;
  };
  const own = {};
  for (const [key, value] of Object.entries(config.compilerOptions ?? {})) {
    if (PATH_OPTIONS.has(key)) own[key] = Array.isArray(value) ? value.map(relative) : relative(value);
    else if (ENUM_OPTIONS.has(key) && typeof value === 'string') own[key] = value.toLowerCase();
    else own[key] = value;
  }
  const { extends: _extends, compilerOptions: _compilerOptions, ...rest } = config;
  // files, include and exclude are relative to the config that sets them: an inherited one is
  // prefixed with its config's directory, as tsc prints it ("../base/src/**/*.ts", not normalized).
  const prefix = path.relative(rootDir, dir).split(path.sep).join('/');
  const pattern = (p) =>
    typeof p !== 'string' ? p : p.startsWith('\${configDir}') ? rootDir + p.slice('\${configDir}'.length) : prefix && !path.isAbsolute(p) ? prefix + '/' + p : p;
  for (const key of ['files', 'include', 'exclude']) if (Array.isArray(rest[key])) rest[key] = rest[key].map(pattern);
  return { ...merged, ...rest, compilerOptions: { ...merged.compilerOptions, ...own } };
}
`;

/**
 * Packages whose native code has a WebAssembly build of the same version with the same API. Each
 * installed copy gets that build installed next to it (in its own node_modules), and the file that
 * loads the native code is replaced by one that loads the WebAssembly build. A build versioned on its
 * own (`wasmVersion`) is installed at that version instead of the package's.
 */
export const WASM_BUILDS: {
  name: string;
  wasm: string;
  wasmVersion?: string;
  file: string;
  applies(version: string): boolean;
  shim: string;
  also?: Record<string, string>;
}[] = [
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
// A transform the host's native esbuild can answer goes there; anything else, and any call it does
// not answer, runs here (src/node-runtime/native-transform.ts).
const native = globalThis[Symbol.for('sandburg.esbuildTransform')];
const transform = (input, options) => {
  const viaHost = native ? native(esbuild.version, input, options) : null;
  return viaHost ? viaHost.then((r) => r || later('transform')(input, options)) : later('transform')(input, options);
};
module.exports = {
  version: esbuild.version,
  build,
  context,
  transform,
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
  {
    // TypeScript 7 (the native port) has no JavaScript compiler: its tsc (lib/tsc.js, which bin/tsc
    // imports) runs the native binary (@typescript/typescript-<platform>). Next.js 16 runs that tsc,
    // as a separate process, for `--showConfig` (all next dev asks) and to type-check builds.
    // `--showConfig` is answered here, from tsconfig.json and its `extends`. The rest runs tsrs, a
    // Rust port of TypeScript 7, as WebAssembly (@tsrs/wasm). tsrs is versioned on its own, follows
    // TypeScript 7.1 (diagnostics can differ from 7.0's), and has no `--showConfig` yet (ADR 0024).
    name: 'typescript',
    wasm: '@tsrs/wasm',
    wasmVersion: '0.18.0-ts7.1.0-dev.20260929',
    file: 'lib/tsc.js',
    applies: (v) => /^7\./.test(v),
    shim: TSC_SHIM,
  },
];


/**
 * Rolldown's builtin plugins that Vite runs from JavaScript (makeBuiltinPluginCallable) get every hook
 * the binding has, and Vite calls each of them for every module: a call into the WebAssembly binding
 * that copies the module's code into it, ~1 ms of the runtime's thread each, for hooks the plugin does
 * not have (rolldown's register_hook_usage) or for modules it leaves alone. Here each known plugin
 * keeps only its own hooks, with Vite's hook filters for the ids or code it can act on, as its Rust
 * source decides (rolldown 1.2): vite-json transforms *.json (is_json_ext); oxc-runtime resolves
 * `@oxc-project/runtime/helpers/…` (and `./…` from one of them: a guard on the importer, which
 * Vite's filters cannot test) and loads what it resolved to; replace transforms only code with one
 * of its keys in it (its matcher's keys, unless objectGuards adds typeof forms); vite-resolve
 * resolves, watches, and loads only its own virtual modules (browser externals, optional peer
 * dependencies, external builtins' facades); the React refresh wrapper has resolveId and transform.
 * A filter is no narrower than the plugin's own test: the plugin decides.
 */
const ROLLDOWN_BUILTIN_HOOKS = `
	// sandburg: see SOURCE_PATCHES
	const sandburgReplace = plugin.name === "builtin:replace" && plugin._options && !plugin._options.objectGuards && plugin._options.values ? Object.keys(plugin._options.values) : null;
	const sandburgHooks = {
		"builtin:vite-json": { transform: { id: /\\.json(?:$|\\?)/ } },
		"builtin:oxc-runtime": { resolveId: (id, importer) => id.startsWith("@oxc-project/runtime/helpers/") || (id.startsWith("./") && typeof importer === "string" && importer.startsWith("\\0@oxc-project+runtime@")), load: { id: /^\\0@oxc-project\\+runtime@/ } },
		"builtin:replace": { transform: sandburgReplace && sandburgReplace.length ? { code: sandburgReplace } : true },
		"builtin:vite-resolve": { resolveId: true, load: { id: /^(?:\\0vite:esm-external-builtin-require:|__vite-browser-external|__vite-optional-peer-dep)/ }, watchChange: true },
		"builtin:vite-react-refresh-wrapper": { resolveId: true, transform: true }
	}[plugin.name];
	if (sandburgHooks) for (const key of ["resolveId", "load", "transform", "watchChange"]) {
		if (!(key in wrappedPlugin)) continue;
		const use = sandburgHooks[key];
		if (!use) delete wrappedPlugin[key];
		else if (typeof use === "function") {
			const hook = wrappedPlugin[key];
			const handler = typeof hook === "object" ? hook.handler : hook;
			const guarded = function(...args) {
				return use(...args) ? handler.apply(this, args) : null;
			};
			wrappedPlugin[key] = typeof hook === "object" ? { ...hook, handler: guarded } : guarded;
		} else if (use !== true) {
			const hook = wrappedPlugin[key];
			wrappedPlugin[key] = typeof hook === "object" ? { ...hook, filter: use } : { handler: hook, filter: use };
		}
	}
	return wrappedPlugin;
}`;

/**
 * Changes to package sources for what the browser cannot do, or does slowly. piscina's workers wait for tasks with
 * Atomics.wait and take them with receiveMessageOnPort, which needs a synchronous look into a
 * MessagePort (browsers have none): they use its message-event mode instead, as under WebContainers.
 */
export const SOURCE_PATCHES: { file: RegExp; from: string | RegExp; to: string }[] = [
  {
    // Vite bundles the project's config file on every start, with esbuild's WebAssembly build (5-7)
    // or rolldown's (8): the bundle of the project's last run is used while the files it was made
    // from are unchanged (node-runtime/config-bundles.ts).
    file: /(^|\/)node_modules\/vite\/dist\/node\/chunks\/[^/]+\.js$/,
    // Once: the browser's install patches a file as it installs it, and its compiler again.
    from: /\nasync function bundleConfigFile\(fileName, isESM\) \{\n(?!  const sandburgBundles)/,
    to:
      '\nasync function bundleConfigFile(fileName, isESM) {\n' +
      "  const sandburgBundles = globalThis[Symbol.for('sandburg.configBundles')]; // sandburg: see SOURCE_PATCHES\n" +
      '  return sandburgBundles ? sandburgBundles(fileName, isESM, () => sandburgBundleConfigFile(fileName, isESM)) : sandburgBundleConfigFile(fileName, isESM);\n' +
      '}\n' +
      'async function sandburgBundleConfigFile(fileName, isESM) {\n',
  },
  {
    // Next.js' webpack cache: read-only unless the run keeps it (a seed run). next dev gzips its cache
    // packs as it stores them, 2.1 s of a warm run's main thread, for a cache no later run reads.
    file: /(^|\/)node_modules\/next\/dist\/build\/webpack-config\.js$/,
    from: /compression: dev \? 'gzip' : false\n/,
    to: "compression: dev ? 'gzip' : false,\n        readonly: process.env.SANDBURG_WEBPACK_CACHE_READONLY === '1' // sandburg: see SOURCE_PATCHES\n",
  },
  {
    // next dev's source maps (`eval-source-map`) for the project's own modules only. Its maps of
    // installed modules (Next.js' and React's, whose stack frames it ignore-lists) were 3/4 of what
    // each run handles: 2/3 of the webpack cache's packs (inflated and restored in every run), 7.4 of
    // the 12 MB of the client's main chunk that the page parses, and the server's chunks. Those modules
    // are built without one (SWC is not asked for it) and emitted as webpack's `eval` devtool emits
    // them, under the same webpack-internal:/// URL: their frames read and are ignore-listed as before
    // (by path), at the module's own lines. The project's modules keep theirs.
    file: /(^|\/)node_modules\/next\/dist\/(esm\/)?build\/webpack\/plugins\/eval-source-map-dev-tool-plugin\.js$/,
    from: /\n(\s*)new (_webpack\.|)SourceMapDevToolModuleOptionsPlugin\(options\)\.apply\(compilation\);\n/,
    to: "\n$1new $2SourceMapDevToolModuleOptionsPlugin(options).apply(compilation);\n$1compilation.hooks.buildModule.tap('SandburgSourceMaps', (m) => { if (/[\\\\/]node_modules[\\\\/]/.test(m.resource ?? '')) m.useSourceMap = false; }); // sandburg: see SOURCE_PATCHES\n",
  },
  {
    file: /(^|\/)node_modules\/next\/dist\/(esm\/)?build\/webpack\/plugins\/eval-source-map-dev-tool-plugin\.js$/,
    from: /\n(\s*)if \(!sourceMap\) \{\n\s*return result\(source\);\n/,
    to:
      '\n$1if (!sourceMap && /[\\\\/]node_modules[\\\\/]/.test(m.resource ?? \'\')) { // sandburg: see SOURCE_PATCHES\n' +
      '$1  const code = JSON.stringify(`${content}\\n//# sourceURL=webpack-internal:///${chunkGraph.getModuleId(m)}\\n`);\n' +
      '$1  return result(new RawSource(`eval(${compilation.outputOptions.trustedTypes ? `${compiler.webpack.RuntimeGlobals.createScript}(${code})` : code});`));\n' +
      '$1}\n' +
      '$1if (!sourceMap) {\n$1    return result(source);\n',
  },
  {
    // Next.js 16.4's dev server asks npm's security advisories about its own version as it starts
    // (experimental.agentUpgrade, 'security' by default): a POST to the registry, which the egress
    // gateway refuses and the network check counted against the app. Off by default here, as with
    // `experimental: { agentUpgrade: false }` in next.config; an app that sets it still gets it.
    file: /(^|\/)node_modules\/next\/dist\/(esm\/)?server\/config-shared\.js$/,
    from: /(\n\s*)agentUpgrade: 'security',/,
    to: '$1agentUpgrade: false, // sandburg: see SOURCE_PATCHES',
  },
  {
    // Next.js 16 runs Turbopack unless told otherwise, and Turbopack has no WebAssembly build: with
    // SWC's WebAssembly build (NEXT_TEST_WASM), no bundler flag means webpack. `--turbopack` stays.
    file: /(^|\/)node_modules\/next\/dist\/(esm\/)?lib\/bundler\.js$/,
    from: /\/\/ The default is turbopack when nothing is configured\.\n(\s*)if \(bundlerFlags\.size === 0\) \{\n/,
    to: "// The default is turbopack when nothing is configured.\n$1if (bundlerFlags.size === 0 && process.env.NEXT_TEST_WASM) return 1; // sandburg: see SOURCE_PATCHES\n$1if (bundlerFlags.size === 0) {\n",
  },
  {
    // Nitro's dev server (Nuxt) holds a request that comes before its worker is ready and checks
    // again every 600 ms: the first page waited up to 0.6 s after the worker was ready. Checked every
    // 50 ms instead, for as long as before (12 times the checks).
    file: /(^|\/)node_modules\/nitropack\/dist\/core\/index\.mjs$/,
    from: /const maxRetries = isTest \|\| isCI \? 100 : 10;\n(\s*)while \(this\.building \|\| \+\+retry < maxRetries\) \{\n([^]*?)await new Promise\(\(resolve2\) => setTimeout\(resolve2, 600\)\);/,
    to: 'const maxRetries = (isTest || isCI ? 100 : 10) * 12; // sandburg: see SOURCE_PATCHES\n$1while (this.building || ++retry < maxRetries) {\n$2await new Promise((resolve2) => setTimeout(resolve2, 50));',
  },
  {
    // rollup's watch mode starts from the cache it is given (it kept one between rebuilds only).
    file: /(^|\/)node_modules\/rollup\/dist\/(es\/)?shared\/watch\.js$/,
    from: /(class Task \{\n\s*constructor\(watcher, options\) \{\n\s*)this\.cache = \{ modules: \[\] \};/,
    to: "$1this.cache = options.cache && typeof options.cache === 'object' && Array.isArray(options.cache.modules) ? options.cache : { modules: [] }; // sandburg: see SOURCE_PATCHES",
  },
  {
    // Nitro's dev server (Nuxt) builds its server with rollup in watch mode on every start (~0.7 s of
    // a warm run's thread: resolving, loading, transforming and parsing ~100 modules, then parsing them
    // all again for rollup's cache). It starts from the cache of the project's last run, which rollup
    // checks module by module (the loaded code must equal the cached original), kept in the runtime's
    // transform cache (node-runtime/transform-cache.ts) and written again only when a module changed.
    file: /(^|\/)node_modules\/nitropack\/dist\/core\/index\.mjs$/,
    from: /function startRollupWatcher\(nitro, rollupConfig\) \{\n(\s*)const watcher = rollup\.watch\(\n(\s*)defu\$1\(rollupConfig, \{/,
    to:
      'function startRollupWatcher(nitro, rollupConfig) {\n' +
      "$1const sandburgStore = globalThis[Symbol.for('sandburg.transformCache')]; // sandburg: see SOURCE_PATCHES\n" +
      '$1let sandburgCache;\n' +
      "$1try { sandburgCache = JSON.parse(sandburgStore?.getFile('nitro-rollup', 'cache.json') ?? 'null') ?? undefined; } catch {}\n" +
      '$1const sandburgSave = (cache) => {\n' +
      "$1  if (!sandburgStore || !cache || !Array.isArray(cache.modules)) return;\n" +
      '$1  const before = new Map((sandburgCache?.modules ?? []).map((m) => [m.id, m.code]));\n' +
      '$1  if (before.size === cache.modules.length && cache.modules.every((m) => before.get(m.id) === m.code)) return;\n' +
      "$1  try { sandburgStore.setFile('nitro-rollup', 'cache.json', JSON.stringify(cache)); sandburgCache = cache; } catch {}\n" +
      '$1};\n' +
      '$1const watcher = rollup.watch(\n' +
      '$2defu$$1(sandburgCache ? { ...rollupConfig, cache: sandburgCache } : rollupConfig, {',
  },
  {
    file: /(^|\/)node_modules\/nitropack\/dist\/core\/index\.mjs$/,
    from: /(case "BUNDLE_END": \{\n)(\s*)(nitro\.hooks\.callHook\("compiled", nitro\);)/,
    to: '$1$2sandburgSave(event.result?.cache); // sandburg: see SOURCE_PATCHES\n$2$3',
  },
  {
    // A build that failed (the app's error, or a cache that no longer fits) leaves no cache for the next run.
    file: /(^|\/)node_modules\/nitropack\/dist\/core\/index\.mjs$/,
    from: /(case "ERROR": \{\n)(\s*)(nitro\.logger\.error\(formatRollupError\(event\.error\)\);\n\s*nitro\.hooks\.callHook\("dev:error", event\.error\);)/,
    to: "$1$2if (sandburgCache) { sandburgCache = undefined; sandburgStore?.setFile('nitro-rollup', 'cache.json', 'null'); } // sandburg: see SOURCE_PATCHES\n$2$3",
  },
  {
    // SolidStart 2's server functions manifest (a virtual module the server entry and the client
    // import) loads once no module with "use server" has been compiled for 1 s: every first page
    // waited 1 s with nothing to do, on the server and again in the client. Here 100 ms. A module
    // compiled later still registers its functions as it runs, and makes the plugin invalidate the
    // manifest, as before; a call to a function no module registered is looked up by its file.
    file: /(^|\/)node_modules\/@solidjs\/start\/dist\/directives\/index\.js$/,
    from: /(this\.timeout = setTimeout\(\(\) => \{\n\s*this\.promise\.resolve\(this\.source\(\)\);\n\s*\}, )1000\);/,
    to: '$1100); // sandburg: see SOURCE_PATCHES',
  },
  {
    file: /(^|\/)node_modules\/rolldown\/dist\/shared\/normalize-string-or-regex-[\w-]+\.mjs$/,
    from: /(const order = callablePlugin\.getOrder\(key\);\n\s*if \(order == void 0\) wrappedPlugin\[key\] = wrappedHook;\n\s*else wrappedPlugin\[key\] = \{\n\s*handler: wrappedHook,\n\s*order\n\s*\};\n\s*\}\n)\treturn wrappedPlugin;\n\}/,
    to: `$1${ROLLDOWN_BUILTIN_HOOKS}`,
  },
  {
    // SolidStart's file-system router lists the routes when its routes module first loads, and told
    // the dev server each route had just been added: in the client, 200 ms later, a hot update of the
    // routes module (and of app.tsx) re-rendered the page. A page that had connected to the dev server
    // by then lost what the checks had typed (1 run in ~20 once runs got faster). The first listing
    // tells no one; later changes to routes do, as before.
    file: /(^|\/)node_modules\/@solidjs\/start\/dist\/config\/fs-routes\/router\.js$/,
    from: /async buildRoutes\(\) \{\n(\s*)for \(var src of glob\(this\.glob\(\)\)\) \{\n\s*await this\.addRoute\(src\);\n\s*\}\n/,
    to: 'async buildRoutes() {\n$1this.sandburgListing = true; // sandburg: see SOURCE_PATCHES\n$1try {\n$1    for (var src of glob(this.glob())) {\n$1        await this.addRoute(src);\n$1    }\n$1} finally {\n$1    this.sandburgListing = false;\n$1}\n',
  },
  {
    file: /(^|\/)node_modules\/@solidjs\/start\/dist\/config\/fs-routes\/router\.js$/,
    from: /reload\(route, type\) \{\n(\s*)this\.dispatchEvent\(/,
    to: 'reload(route, type) {\n$1if (this.sandburgListing) return; // sandburg: see SOURCE_PATCHES\n$1this.dispatchEvent(',
  },
  {
    // vite-plugin-solid compiles every .jsx/.tsx module with Babel, for the server and again for the
    // client (~1.2 s of a warm SolidStart run's thread, its own dev toolbar's modules included): it
    // looks the compile up in the project's transform cache first (node-runtime/transform-cache.ts),
    // unless the app passes Babel options of its own.
    file: /(^|\/)node_modules\/vite-plugin-solid\/dist\/(esm\/index\.mjs|cjs\/index\.cjs)$/,
    from: /(const babelOptions = (?:mergeAnything\.)?mergeAndConcat\(babelUserOptions, opts\);\n)(\s*)(const \{\n\s*code,\n\s*map\n\s*\} = await (babel|babel__namespace)\.transformAsync\(source, babelOptions\);\n)/,
    to:
      "$1$2const sandburgCache = options.babel ? undefined : globalThis[Symbol.for('sandburg.transformCache')]; // sandburg: see SOURCE_PATCHES\n" +
      "$2const sandburgHit = sandburgCache?.get('vite-plugin-solid', id, isSsr, source);\n" +
      '$2if (sandburgHit) return sandburgHit;\n' +
      '$2$3' +
      "$2sandburgCache?.set('vite-plugin-solid', id, isSsr, source, { code, map });\n",
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

/**
 * The emnapi a tree of WebAssembly bindings is to be resolved again with, given each
 * @napi-rs/wasm-runtime in it (its peer range for @emnapi/core) and the @emnapi/core it resolves.
 * Since 1.2.6 the runtime bundles emnapi plugins that use @emnapi/core's private fields, and takes
 * only the exact 2.x prerelease they were built against (its peer range: "^1.7.1 || 2.0.0-beta.2").
 * Bindings pin the emnapi they were built with (rolldown 1.2.15: 2.0.0-alpha.5) and take the
 * runtime by range, so a new runtime arrives beside an emnapi it does not load with ("Cannot set
 * properties of undefined (setting 'initWorker')"). The bindings' WebAssembly works with the newer
 * emnapi (rolldown's parses and bundles), so @emnapi/core and @emnapi/runtime are overridden to it.
 * null: nothing to align (no runtime, no exact version, an emnapi 1.x, or runtimes that want
 * different ones).
 */
export function emnapiToAlign(runtimes: { peer?: string; core?: string }[]): string | null {
  const needed = new Set<string>();
  let mismatch = false;
  for (const { peer, core } of runtimes) {
    const exact = (peer ?? '')
      .split('||')
      .map((alt) => alt.trim())
      .find((alt) => /^2\.\d+\.\d+-[\w.]+$/.test(alt));
    if (!exact) continue;
    needed.add(exact);
    // emnapi 1.x ignores the plugins, and loads with any runtime (satteri's binding pins 1.11.1).
    if (core !== exact && core?.startsWith('2.')) mismatch = true;
  }
  return mismatch && needed.size === 1 ? [...needed][0] : null;
}

/** npm overrides that give a tree of WebAssembly bindings the emnapi its runtime needs (emnapiToAlign). */
export const emnapiOverrides = (version: string) => ({ '@emnapi/core': version, '@emnapi/runtime': version });
