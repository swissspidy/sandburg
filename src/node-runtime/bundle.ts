/** Builds the runtime worker bundle (served by the host at /__sandburg/node-worker.js). */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

let cached: Promise<string> | null = null;

export function bundleNodeRuntime(): Promise<string> {
  cached ??= esbuild
    .build({
      entryPoints: [here('./worker.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
      inject: [here('./globals-shim.ts')],
      define: { global: 'globalThis' },
      plugins: [
        {
          name: 'process-alias',
          setup(build) {
            build.onResolve({ filter: /^process\/?$/ }, () => ({ path: here('./process-alias.cjs') }));
            // Polyfills require Node built-ins among themselves; map them to their polyfills.
            const map: Record<string, string> = { stream: 'readable-stream', path: 'path-browserify', crypto: 'crypto-browserify', zlib: 'browserify-zlib', querystring: 'querystring-es3' };
            build.onResolve({ filter: /^(stream|path|crypto|zlib|querystring|buffer|events|util|assert|string_decoder|url)\/?$/ }, (args) => {
              if (args.pluginData === 'sandburg-inner') return undefined; // our own re-resolve below
              const name = args.path.replace(/\/$/, '');
              if (args.importer.includes('/src/node-runtime/') && !map[name]) return undefined;
              return build.resolve(map[name] ?? `${name}/`, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 'sandburg-inner' });
            });
          },
        },
      ],
    })
    .then((r) => r.outputFiles[0].text);
  cached.catch(() => (cached = null));
  return cached;
}

/** The official SQLite WebAssembly build (Apache-2.0), loaded by the runtime with importScripts when an app uses SQLite. */
export const SQLITE_WASM = fileURLToPath(new URL('../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', import.meta.url));

let sqliteBundle: Promise<string> | null = null;

export function bundleSqlite(): Promise<string> {
  sqliteBundle ??= esbuild
    .build({
      entryPoints: [fileURLToPath(new URL('../../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs', import.meta.url))],
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
