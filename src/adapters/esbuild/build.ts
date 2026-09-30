/**
 * The esbuild adapter's build (ADR 0007): what `vite` does for a browser app,
 * done with esbuild in one pass.
 *
 * - index.html's `<script type="module" src>` entries are bundled (ESM,
 *   code splitting). CSS imported by them becomes a stylesheet link.
 * - TS/TSX/JSX, JSON, CSS and CSS modules, and assets (files, `?url`, `?raw`)
 *   are handled as Vite does.
 * - `import.meta.env` has MODE, DEV, PROD, SSR, BASE_URL and the VITE_*
 *   variables from .env, .env.local, .env.development and .env.development.local.
 * - Modules resolve through `Resolver` over the project files and the
 *   installed node_modules (real npm packages; nothing comes from a CDN).
 *
 * It takes the esbuild API as a parameter, so it runs with esbuild-wasm in the
 * browser and with native esbuild in tests.
 */
import type * as esbuildTypes from 'esbuild';
import { Resolver, dirname, readAliases, stripJsonComments, type FileSystem } from './resolve.ts';
import { Tailwind, scanCandidates, usesTailwind } from './tailwind.ts';
import { STYLE_QUERY, VueCompiler } from './vue.ts';

type Esbuild = Pick<typeof esbuildTypes, 'build'>;

export interface BuildInput {
  /** Project files, keyed by path relative to the project root. */
  files: Record<string, string | Uint8Array>;
  /** Installed node_modules files, as absolute paths ("/node_modules/react/index.js"). */
  nodeModules: Iterable<string>;
  readNodeModule(path: string): Promise<Uint8Array>;
  mode?: string;
  /** The page to build from, when it is not the project's index.html (Angular's comes from angular.json). */
  indexHtml?: string;
  /** Extra compile-time constants (esbuild `define`). */
  define?: Record<string, string>;
}

export interface Asset {
  body: Uint8Array;
  type: string;
}

export interface BuildOutput {
  /** Build outputs by URL path ("/assets/main-X.js"). */
  assets: Map<string, Asset>;
  /** index.html with its module scripts replaced by the bundles. */
  html: string;
  warnings: string[];
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

export const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
};

export function mimeType(path: string): string {
  return MIME[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

const ASSET_EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'pdf', 'txt', 'wasm'];

/** Module scripts in index.html: `<script type="module" src="…"></script>`. */
const MODULE_SCRIPT = /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["']([^"']+)["'])[^>]*>\s*<\/script>/gi;

export async function buildApp(esbuild: Esbuild, input: BuildInput): Promise<BuildOutput> {
  const mode = input.mode ?? 'development';
  const files = input.files;
  const html = input.indexHtml ?? files['index.html'];
  if (typeof html !== 'string') throw new BuildError('index.html is missing: a Vite app is served from index.html at the project root');

  const fileSet = new Set<string>();
  for (const p of Object.keys(files)) fileSet.add(`/${p}`);
  for (const p of input.nodeModules) fileSet.add(p);
  const dirs = new Set<string>();
  for (const p of fileSet) for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i));

  // A dependency that cannot be read is an infrastructure failure, not a build error.
  let readFailure: Error | null = null;
  const read = async (path: string): Promise<Uint8Array> => {
    const own = files[path.slice(1)];
    if (own !== undefined) return typeof own === 'string' ? new TextEncoder().encode(own) : own;
    try {
      const bytes = await input.readNodeModule(path);
      // Dependencies' own source maps are not shipped with the fetch; esbuild would try to read them.
      return /\.(m|c)?js$/.test(path) ? stripSourceMapComment(bytes) : bytes;
    } catch (e) {
      readFailure ??= e as Error;
      throw e;
    }
  };
  const fs: FileSystem = {
    isFile: (p) => fileSet.has(p),
    isDir: (p) => dirs.has(p),
    readJson: async (p) => JSON.parse(new TextDecoder().decode(await read(p))),
  };
  const resolver = new Resolver(fs, readAliases(files));
  const warnings: string[] = [];
  const nodeEnv = JSON.stringify(mode === 'production' ? 'production' : 'development');
  // Bundles an installed package (Tailwind, @vue/compiler-sfc) and imports it in this realm.
  const importPackage = async (path: string) => {
    const out = await esbuild.build({
      entryPoints: [path],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': nodeEnv },
      plugins: [vfsPlugin(resolver, read, [])],
    });
    return import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(out.outputFiles[0].text)}`);
  };
  const tailwind = new Tailwind({ resolver, read, importPackage });
  let candidates: string[] | null = null;
  const vue = new VueCompiler({ resolver, files, importPackage });
  /** Compiled <style> blocks of .vue files, by "<path>?vue&type=style&index=N&lang.css". */
  const sfcStyles = new Map<string, string>();

  const entries: string[] = [];
  for (const [, src] of html.matchAll(MODULE_SCRIPT)) {
    if (/^(https?:)?\/\//.test(src)) continue;
    const r = await resolver.resolve(src.startsWith('/') || src.startsWith('.') ? src : `./${src}`, '/index.html').catch((e: Error) => {
      throw new BuildError(`index.html: ${e.message}`);
    });
    if ('path' in r) entries.push(r.path);
  }
  if (!entries.length) throw new BuildError('index.html has no <script type="module" src="…"> entry');

  const env = { ...loadEnv(files, mode), MODE: mode, DEV: mode !== 'production', PROD: mode === 'production', SSR: false, BASE_URL: '/' };
  const define: Record<string, string> = {
    'import.meta.env': JSON.stringify(env),
    'process.env.NODE_ENV': nodeEnv,
    // Vue's compile-time flags, as @vitejs/plugin-vue defines them for development.
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  };
  for (const [k, v] of Object.entries(env)) define[`import.meta.env.${k}`] = JSON.stringify(v);
  Object.assign(define, input.define);
  const tsconfig = readTsconfig(files);

  let result: esbuildTypes.BuildResult & { metafile: esbuildTypes.Metafile; outputFiles: esbuildTypes.OutputFile[] };
  try {
    result = (await esbuild.build({
      entryPoints: entries,
      absWorkingDir: '/',
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      outdir: '/',
      entryNames: 'assets/[name]-[hash]',
      chunkNames: 'assets/[name]-[hash]',
      assetNames: 'assets/[name]-[hash]',
      publicPath: '/',
      write: false,
      metafile: true,
      sourcemap: true,
      jsx: 'automatic',
      jsxImportSource: tsconfig.jsxImportSource ?? 'react',
      define,
      logLevel: 'silent',
      loader: Object.fromEntries(ASSET_EXTENSIONS.map((e) => [`.${e}`, 'file'])),
      plugins: [
        {
          name: 'sandburg-vfs',
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (args.namespace === 'sandburg-empty') return { path: args.path, namespace: 'sandburg-empty' };
              if (STYLE_QUERY.test(args.path) && sfcStyles.has(args.path)) return { path: args.path, namespace: 'sandburg-vue-style' };
              // Vite serves public/ at the root and leaves such URLs in CSS as they are.
              if ((args.kind === 'url-token' || args.kind === 'import-rule') && args.path.startsWith('/') && `public${args.path}` in files) {
                return { path: args.path, external: true };
              }
              let r;
              try {
                r = await resolver.resolve(args.path, args.importer === '<stdin>' ? '' : args.importer, { style: args.kind === 'import-rule' });
              } catch (e) {
                return { errors: [{ text: (e as Error).message }] };
              }
              if ('external' in r) return { path: args.path, external: true };
              if ('empty' in r) {
                warnings.push(`${r.reason} (imported by ${args.importer})`);
                return { path: args.path, namespace: 'sandburg-empty' };
              }
              const [path, query] = [r.path.replace(/[?#].*$/, ''), /[?#].*$/.exec(r.path)?.[0] ?? ''];
              if (/[?&]raw\b/.test(query)) return { path, namespace: 'sandburg-raw' };
              if (/[?&]url\b/.test(query)) return { path, namespace: 'sandburg-url' };
              if (/[?&]inline\b/.test(query) && path.endsWith('.css')) return { path, namespace: 'sandburg-css-inline' };
              return { path, namespace: 'sandburg' };
            });
            build.onLoad({ filter: /.*/, namespace: 'sandburg-empty' }, () => ({ contents: 'export default {};', loader: 'js' }));
            build.onLoad({ filter: /.*/, namespace: 'sandburg-raw' }, async (args) => ({ contents: await read(args.path), loader: 'text' }));
            build.onLoad({ filter: /.*/, namespace: 'sandburg-url' }, async (args) => ({ contents: await read(args.path), loader: 'file' }));
            build.onLoad({ filter: /.*/, namespace: 'sandburg-css-inline' }, async (args) => ({ contents: await read(args.path), loader: 'text' }));
            build.onLoad({ filter: /.*/, namespace: 'sandburg-vue-style' }, (args) => ({ contents: sfcStyles.get(args.path), loader: 'css', resolveDir: dirname(args.path) }));
            build.onLoad({ filter: /.*/, namespace: 'sandburg' }, async (args) => {
              const contents = await read(args.path);
              if (args.path.endsWith('.vue')) {
                try {
                  const sfc = await vue.compile(new TextDecoder().decode(contents), args.path);
                  sfc.styles.forEach((css, i) => sfcStyles.set(`${args.path}?vue&type=style&index=${i}&lang.css`, css));
                  return { contents: sfc.code, loader: sfc.loader, resolveDir: dirname(args.path) };
                } catch (e) {
                  return { errors: [{ text: (e as Error).message }] };
                }
              }
              const loader = loaderFor(args.path);
              if ((loader === 'css' || loader === 'local-css') && !args.path.includes('/node_modules/')) {
                const css = new TextDecoder().decode(contents);
                if (usesTailwind(css)) {
                  candidates ??= scanCandidates(files);
                  try {
                    return { contents: await tailwind.compile(css, args.path, candidates), loader, resolveDir: dirname(args.path) };
                  } catch (e) {
                    return { errors: [{ text: `Tailwind CSS: ${(e as Error).message}` }] };
                  }
                }
              }
              return { contents, loader, resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    })) as typeof result;
  } catch (e) {
    const failure = e as { errors?: esbuildTypes.Message[] };
    if (readFailure) throw new Error(`runtime asset failed to load: ${(readFailure as Error).message}`);
    if (failure.errors?.length) throw new BuildError(failure.errors.slice(0, 10).map(formatMessage).join('\n'));
    throw e;
  }
  for (const w of result.warnings) warnings.push(formatMessage(w));

  const assets = new Map<string, Asset>();
  for (const out of result.outputFiles) {
    const path = out.path.startsWith('/') ? out.path : `/${out.path}`;
    assets.set(path, { body: out.contents, type: mimeType(path) });
  }

  // Map each entry to its bundle (and CSS) and rewrite index.html.
  const byEntry = new Map<string, { js: string; css?: string }>();
  for (const [out, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.entryPoint) byEntry.set(meta.entryPoint.replace(/^sandburg:/, ''), { js: `/${out.replace(/^\//, '')}`, css: meta.cssBundle ? `/${meta.cssBundle.replace(/^\//, '')}` : undefined });
  }
  let i = 0;
  const page = html
    .replace(MODULE_SCRIPT, (tag, src: string) => {
      if (/^(https?:)?\/\//.test(src)) return tag;
      const out = byEntry.get(entries[i++]);
      if (!out) return tag;
      return `${out.css ? `<link rel="stylesheet" href="${out.css}">` : ''}<script type="module" src="${out.js}"></script>`;
    })
    .replace(/%(\w+)%/g, (m, name: string) => (name in env ? String(env[name as keyof typeof env]) : m));

  return { assets, html: page, warnings };
}

/** Resolution and loading only (no Vite semantics): for bundling installed packages such as Tailwind. */
function vfsPlugin(resolver: Resolver, read: (path: string) => Promise<Uint8Array>, warnings: string[]): esbuildTypes.Plugin {
  return {
    name: 'sandburg-packages',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        try {
          const r = await resolver.resolve(args.path, args.importer);
          if ('external' in r) return { path: args.path, external: true };
          if ('empty' in r) {
            warnings.push(r.reason);
            return { path: args.path, namespace: 'sandburg-empty' };
          }
          return { path: r.path.replace(/[?#].*$/, ''), namespace: 'sandburg' };
        } catch (e) {
          return { errors: [{ text: (e as Error).message }] };
        }
      });
      build.onLoad({ filter: /.*/, namespace: 'sandburg-empty' }, () => ({ contents: 'export default {};', loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'sandburg' }, async (args) => ({ contents: await read(args.path), loader: loaderFor(args.path) }));
    },
  };
}

function stripSourceMapComment(bytes: Uint8Array): Uint8Array {
  const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 300)));
  const m = /\n\/\/[#@] sourceMappingURL=[^\n]*\s*$/.exec(tail);
  return m ? bytes.subarray(0, bytes.length - new TextEncoder().encode(tail.slice(m.index)).length) : bytes;
}

function loaderFor(path: string): esbuildTypes.Loader {
  if (path.endsWith('.module.css')) return 'local-css';
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'jsx':
      return 'jsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    default:
      return ASSET_EXTENSIONS.includes(ext) ? 'file' : 'text';
  }
}

function formatMessage(m: esbuildTypes.Message): string {
  const at = m.location ? `${m.location.file.replace(/^sandburg:/, '')}:${m.location.line}:${m.location.column}: ` : '';
  return `${at}${m.text}${m.location?.lineText ? `\n    ${m.location.lineText.trim()}` : ''}`;
}

/** VITE_* variables from the .env files Vite reads in `mode`, later files winning. */
export function loadEnv(files: Record<string, string | Uint8Array>, mode: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const text = files[name];
    if (typeof text !== 'string') continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || !m[1].startsWith('VITE_')) continue;
      let value = m[2];
      const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
      value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
      env[m[1]] = value;
    }
  }
  return env;
}

function readTsconfig(files: Record<string, string | Uint8Array>): { jsxImportSource?: string } {
  for (const name of ['tsconfig.app.json', 'tsconfig.json', 'jsconfig.json']) {
    const text = files[name];
    if (typeof text !== 'string') continue;
    try {
      const json = JSON.parse(stripJsonComments(text)) as { compilerOptions?: { jsxImportSource?: string } };
      if (json.compilerOptions?.jsxImportSource) return { jsxImportSource: json.compilerOptions.jsxImportSource };
    } catch {
      // ignore
    }
  }
  return {};
}
