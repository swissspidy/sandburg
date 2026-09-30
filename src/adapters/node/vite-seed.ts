/**
 * Seeds of Vite's pre-bundled dependencies (node_modules/.vite/deps), shared by apps that would
 * pre-bundle the same thing.
 *
 * On a first run Vite pre-bundles the dependencies an app imports, with esbuild's WebAssembly build
 * in one thread (Vite ≤6) or rolldown's: a large package such as lucide-react takes most of a
 * minute. What it produces depends on the installed packages, the Vite config and the lockfile, and
 * on which packages the app imports, but not on the app's own code. So apps that agree on all of
 * those can start from the same cache, and Vite checks the cache's hash (lockfile, config) before it
 * uses it.
 *
 * The cache must not come from an app's own run: its page runs the app's code and could upload
 * anything (see DEV_CACHE_DIRS in index.ts). A seed is a project that the session makes and runs
 * itself: the app's settings (package.json, lockfile, the Vite config and the files it imports,
 * tsconfig, .env) and an entry that imports the same packages and never runs them. All of it is
 * part of the key, so what a seed run produces is a function of its key, and no app can plant code
 * in another app's cache.
 */
import { createHash } from 'node:crypto';
import type { FileTree, Project } from '../../types.ts';
import { projectFromFiles } from '../../project.ts';

export const VITE_SEED_DIRS = ['node_modules/.vite/deps'];
export const VITE_SEED_WAIT = ['node_modules/.vite/deps/_metadata.json'];
const ENTRY = 'src/sandburg-seed.js';

const IMPORT = /(?:\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?|\bexport\s*[\w*{}\s,$]+?\s*from\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/g;
const SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
const SRC = /\bsrc=["']([^"']+)["']/i;
const ASSET = /\.(?:css|scss|sass|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|txt|md)(?:\?.*)?$/;
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** The package a bare specifier names (react-dom/client → react-dom, @scope/pkg/x → @scope/pkg), or null. */
function packageName(specifier: string): string | null {
  if (/^(?:[./#~\0]|@\/|[a-z]+:)/i.test(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? (parts.length > 1 && parts[0].length > 1 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
}

/**
 * The installed packages the app imports in the browser, found as Vite's dependency scan finds them:
 * from the module scripts of the HTML files, following local imports. (Imports through aliases are
 * not followed: Vite then finds the rest itself and pre-bundles again.)
 */
export function importedPackages(files: FileTree): string[] {
  const deps = typeof files['package.json'] === 'string' ? safeDeps(files['package.json']) : {};
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [];
  const visit = (code: string, dir: string) => {
    for (const m of code.matchAll(IMPORT)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const base = spec.startsWith('/') ? spec.slice(1) : new URL(spec, `file:///${dir}`).pathname.slice(1);
        const hit = EXTENSIONS.map((e) => base.replace(/\?.*$/, '') + e).find((c) => typeof files[c] === 'string' && CODE.test(c));
        if (hit) queue.push(hit);
        continue;
      }
      const name = packageName(spec);
      if (name && name in deps && name !== 'vite' && !ASSET.test(spec)) found.add(spec);
    }
  };
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.html') || path.startsWith('node_modules/') || path.startsWith('public/') || typeof content !== 'string') continue;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const m of content.matchAll(SCRIPT)) {
      const src = SRC.exec(m[0].slice(0, m[0].indexOf('>') + 1))?.[1];
      if (src) visit(`import ${JSON.stringify(src)};`, dir);
      else visit(m[1], dir);
    }
  }
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    visit(files[path] as string, dir);
  }
  return [...found].sort();
}

function safeDeps(pkg: string): Record<string, string> {
  try {
    const p = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return { ...p.dependencies, ...p.devDependencies };
  } catch {
    return {};
  }
}

/**
 * The seed for a Vite app, or null when there is nothing to share (no imported packages), or the app
 * controls what Vite pre-bundles in ways a seed cannot reproduce (optimizeDeps settings).
 */
export function viteSeed(project: Project, installKey: string, salt: string): { key: string; project: Project } | null {
  if (project.framework !== 'vite') return null;
  const specifiers = importedPackages(project.files);
  if (!specifiers.length) return null;
  const kept = settingsFiles(project.files);
  if (Object.entries(kept).some(([path, content]) => /(^|\/)vite\.config\.[cm]?[jt]s$/.test(path) && typeof content === 'string' && /optimizeDeps/.test(content))) return null;

  const h = createHash('sha256').update(`vite-seed\0${salt}\0${installKey}\0${JSON.stringify(specifiers)}\0`);
  for (const path of Object.keys(kept).sort()) {
    const content = path === 'package.json' ? normalizedPackageJson(kept[path]) : kept[path];
    h.update(path).update('\0').update(typeof content === 'string' ? content : JSON.stringify(content)).update('\0');
  }
  const key = h.digest('hex').slice(0, 24);

  const files: FileTree = {
    ...kept,
    'index.html': `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Sandburg seed</title></head>\n<body><p>Seed</p><script type="module" src="/${ENTRY}"></script></body>\n</html>\n`,
    // Vite's scan finds these imports and pre-bundles them; the page never calls load().
    [ENTRY]: `// Sandburg: the packages the app imports, for Vite to pre-bundle.\nexport const load = () => [\n${specifiers.map((s) => `  import(${JSON.stringify(s)}),`).join('\n')}\n];\n`,
  };
  return { key, project: { ...projectFromFiles(files, { name: '', path: `sandburg:vite-seed/${key}` }), name: `sandburg-vite-seed-${key}` } };
}

const SETTINGS = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|\.env(?:\.[\w.-]+)?|\.npmrc|[\w.-]+\.config\.[cm]?[jt]s)$/;
const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g;

/** The files that decide what Vite pre-bundles: settings at the root, and the local files configs import. */
function settingsFiles(files: FileTree): FileTree {
  const kept: FileTree = {};
  const queue = Object.keys(files).filter((p) => SETTINGS.test(p));
  while (queue.length) {
    const path = queue.pop()!;
    if (path in kept || !(path in files)) continue;
    kept[path] = files[path];
    const content = files[path];
    if (typeof content !== 'string' || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const m of content.matchAll(RELATIVE)) {
      const target = new URL(m[1], `file:///${dir}`).pathname.slice(1);
      for (const candidate of [target, ...['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts', '/index.ts', '/index.js'].map((e) => target + e)]) {
        if (candidate in files) queue.push(candidate);
      }
    }
  }
  return kept;
}

/** package.json as it matters to installing and running Vite: without the name and other labels. */
function normalizedPackageJson(content: FileTree[string]): string {
  if (typeof content !== 'string') return JSON.stringify(content);
  try {
    const { name: _n, version: _v, description: _d, private: _p, author: _a, license: _l, ...rest } = JSON.parse(content) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return content;
  }
}
