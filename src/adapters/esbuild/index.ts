/**
 * esbuild adapter (Node half): builds Vite-style browser apps in the browser
 * with esbuild-wasm and serves the output from the sandbox's service worker
 * (ADR 0007). Dependencies are real npm packages, installed on the host with
 * the node adapter's install cache (--ignore-scripts) and read lazily.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterDescriptor, HostRequest, HostResponse, Project } from '../../types.ts';
import { sharedInstaller } from '../node/install.ts';
import { serve as serveNode } from '../node/index.ts';
import { detectFramework } from '../../project.ts';
import { findFullStack, type ProxyRule } from './backend.ts';

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve('esbuild-wasm/package.json'));
const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };

export interface EsbuildHostInstall {
  key: string | null;
  /** node_modules files (relative paths, e.g. "node_modules/react/index.js") → size. */
  index: Record<string, number>;
  resolved: Record<string, string>;
  lockfile: boolean;
  /** Directory of the front end ("" is the project root). */
  frontend?: string;
  /** The backend the dev scripts start alongside Vite (ADR 0009). */
  backend?: {
    /** Package directory, and the server entry relative to it. */
    dir: string;
    main: string;
    command: string;
    key: string | null;
    index: Record<string, number>;
  } | null;
  proxy?: ProxyRule[];
}

/** The package in `dir` as a project of its own (a client/ or server/ package). */
export function subProject(project: Project, dir: string): Project {
  if (!dir) return project;
  const prefix = `${dir}/`;
  const files: Project['files'] = {};
  for (const [path, content] of Object.entries(project.files)) if (path.startsWith(prefix)) files[path.slice(prefix.length)] = content;
  let packageJson: Project['packageJson'] = null;
  try {
    packageJson = typeof files['package.json'] === 'string' ? JSON.parse(files['package.json']) : null;
  } catch {
    // reported by npm at install
  }
  return { ...project, name: `${project.name}/${dir}`, files, packageJson, framework: detectFramework(files, packageJson) };
}

async function installPackage(project: Project, log: (line: string) => void) {
  const pkg = project.packageJson;
  if (!pkg || !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) return { key: null, index: {}, resolved: {}, lockfile: false };
  const installer = sharedInstaller();
  const info = await installer.install(project, {}, log);
  return { key: info.key, index: await installer.index(info.key), resolved: info.resolved, lockfile: info.lockfile };
}

/** Vite config imports that the esbuild build covers by itself. */
const BUILT_IN = /^(vite|node:.*|path|url|fs|@vitejs\/plugin-(react(-swc)?|vue)|@tailwindcss\/vite|@sveltejs\/vite-plugin-svelte|vite-plugin-solid|@preact\/preset-vite)$/;

/** Plugins imported by vite.config that the build cannot apply. */
export function unsupportedVitePlugins(project: Project): string[] {
  const config = Object.entries(project.files).find(([p]) => /^vite\.config\.[cm]?[jt]s$/.test(p))?.[1];
  if (typeof config !== 'string') return [];
  const imported = [...config.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
  return imported.filter((name) => !name.startsWith('.') && !BUILT_IN.test(name));
}

/** Code files that are fetched per directory (see directoryPack). */
export const PACKED = /\.(m?js|cjs|json|css)$/;
const PACK_FILE_MAX = 256 * 1024;

/**
 * The small code files directly in one node_modules directory, as JSON
 * { name: text }. Bundling reads a package's modules one by one; icon sets such
 * as lucide-react have well over a thousand, so the browser asks for a
 * directory at once instead.
 */
async function directoryPack(key: string, dir: string): Promise<Buffer | null> {
  if (!dir.startsWith('node_modules/') || dir.split('/').includes('..')) return null;
  const installer = sharedInstaller();
  const index = await installer.index(key).catch(() => null);
  if (!index) return null;
  const pack: Record<string, string> = {};
  for (const [path, size] of Object.entries(index)) {
    if (!path.startsWith(`${dir}/`) || path.includes('/', dir.length + 1) || !PACKED.test(path) || size > PACK_FILE_MAX) continue;
    const file = await installer.raw(key, path);
    if (file) pack[path.slice(dir.length + 1)] = file.body.toString('utf8');
  }
  return Buffer.from(JSON.stringify(pack));
}

/** PostCSS plugins other than Tailwind v4's (which the build applies itself) and autoprefixer (not needed in Chromium). */
export function unsupportedPostcssPlugins(project: Project): string[] {
  const entry = Object.entries(project.files).find(([p]) => /^(postcss\.config\.[cm]?[jt]s|\.postcssrc(\.json)?)$/.test(p));
  if (!entry || typeof entry[1] !== 'string') return [];
  const names = [...entry[1].matchAll(/['"]((?:@[\w.-]+\/)?[\w.-]*(?:postcss|tailwind|autoprefixer|cssnano)[\w.-]*)['"]/g)].map((m) => m[1]);
  return [...new Set(names)].filter((n) => n !== '@tailwindcss/postcss' && n !== 'autoprefixer');
}

export async function serve(req: HostRequest): Promise<HostResponse | null> {
  if (req.path === '/__sandburg/esbuild.wasm') {
    return { status: 200, headers: { 'content-type': 'application/wasm', 'cache-control': 'max-age=31536000, immutable' }, body: await readFile(join(pkgRoot, 'esbuild.wasm')) };
  }
  const d = /^\/__sandburg\/nm\/([0-9a-f]{24})\/d\/(.+)$/.exec(req.path);
  if (d) {
    const pack = await directoryPack(d[1], decodeURIComponent(d[2]));
    return pack ? { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=31536000, immutable' }, body: pack } : null;
  }
  const m = /^\/__sandburg\/nm\/([0-9a-f]{24})\/f\/(.+)$/.exec(req.path);
  if (m) {
    const file = await sharedInstaller().raw(m[1], decodeURIComponent(m[2]));
    return file ? { status: 200, headers: { 'content-type': file.type, 'cache-control': 'max-age=31536000, immutable' }, body: file.body } : null;
  }
  // The backend runs in the node runtime (its worker bundle, compile endpoint and transformed files).
  return serveNode(req);
}

export const esbuildAdapter: AdapterDescriptor = {
  name: 'esbuild',
  version,
  browserEntry: fileURLToPath(new URL('./browser.ts', import.meta.url)),
  assets: { '/__sw__.js': fileURLToPath(new URL('../node/sw.js', import.meta.url)) },
  // Stylesheets and fonts that apps commonly link from index.html.
  egress: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  crossOriginIsolation: false,
  timeouts: { install: 600_000 },
  probe(whole: Project) {
    const layout = findFullStack(whole.files);
    const project = subProject(whole, layout.frontend);
    if (!('index.html' in project.files)) return { verdict: 'unsupported', reason: `no index.html in the front end (${layout.frontend || 'the project root'})` };
    if (project.framework !== 'vite' && project.framework !== 'static' && project.framework !== 'unknown') {
      return { verdict: 'unsupported', reason: `framework "${project.framework}" is not supported by the esbuild adapter` };
    }
    const plugins = unsupportedVitePlugins(project);
    if (plugins.length) return { verdict: 'unsupported', reason: `Vite plugins are not applied by the esbuild adapter: ${plugins.join(', ')}` };
    const deps = { ...project.packageJson?.dependencies, ...project.packageJson?.devDependencies };
    if (typeof deps.tailwindcss === 'string' && /^[\^~>=\s]*[0-3](\.|$)/.test(deps.tailwindcss)) {
      return { verdict: 'unsupported', reason: `Tailwind CSS ${deps.tailwindcss} runs as a PostCSS plugin; the esbuild adapter supports Tailwind v4 only` };
    }
    const postcss = unsupportedPostcssPlugins(project);
    if (postcss.length) return { verdict: 'unsupported', reason: `PostCSS plugins are not run by the esbuild adapter: ${postcss.join(', ')}` };
    return { verdict: 'supported' };
  },
  async hostInstall(project, log): Promise<EsbuildHostInstall> {
    const layout = findFullStack(project.files);
    const front = await installPackage(subProject(project, layout.frontend), log);
    let backend: EsbuildHostInstall['backend'] = null;
    if (layout.backend) {
      const { dir, main, command } = layout.backend;
      const deps = dir === layout.frontend ? front : await installPackage(subProject(project, dir), log);
      backend = { dir, main, command, key: deps.key, index: deps.index };
    }
    return { ...front, frontend: layout.frontend, backend, proxy: layout.proxy };
  },
  serve,
};
