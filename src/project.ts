/**
 * Project input: a directory, a .zip archive, a JSON file tree, or a stored
 * snapshot ("snapshot:<id or prefix>").
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { isText, manifestOf, snapshotId, type SnapshotStore } from './store.ts';
import type { FileTree, Framework, PackageJson, Project } from './types.ts';
import { readZip, stripCommonRoot } from './zip.ts';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.sandburg', '.turbo', '.cache']);
/** Sandburg's own check files are not part of the app. */
const IGNORED_FILES = /\.(spec|test)\.[cm]?[jt]sx?$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function loadProject(path: string, store?: SnapshotStore): Promise<Project> {
  if (path.startsWith('snapshot:')) {
    if (!store) throw new Error('loading a snapshot needs a snapshot store');
    const { record, files } = await store.get(path.slice('snapshot:'.length));
    return projectFromFiles(files, { name: record.name, path });
  }
  const abs = resolve(path);
  const info = await stat(abs);
  let files: FileTree;
  let name: string;
  if (info.isDirectory()) {
    files = await readDirectory(abs);
    name = basename(abs);
  } else if (abs.endsWith('.json')) {
    files = parseFileTree(JSON.parse(await readFile(abs, 'utf8')));
    name = basename(abs, '.json');
  } else if (abs.endsWith('.zip')) {
    files = filesFromZip(await readFile(abs));
    name = basename(abs, '.zip');
  } else {
    throw new Error(`unsupported project input: ${path} (expected a directory, a .zip, or a .json file tree)`);
  }
  return projectFromFiles(files, { name, path: abs });
}

export function projectFromFiles(files: FileTree, meta: { name: string; path: string }): Project {
  let packageJson: PackageJson | null = null;
  const pkgSource = files['package.json'];
  if (typeof pkgSource === 'string') {
    try {
      packageJson = JSON.parse(pkgSource);
    } catch {
      packageJson = null; // The adapter reports broken package.json as an app bug.
    }
  }
  return {
    name: packageJson?.name ?? meta.name,
    path: meta.path,
    files,
    packageJson,
    framework: detectFramework(files, packageJson),
    snapshotId: snapshotId(manifestOf(files)),
  };
}

export function detectFramework(files: FileTree, pkg: PackageJson | null): Framework {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const paths = Object.keys(files);
  if ('next' in deps || paths.some((p) => /^next\.config\.[cm]?[jt]s$/.test(p))) return 'next';
  if ('@angular/core' in deps || 'angular.json' in files) return 'angular';
  if ('@sveltejs/kit' in deps) return 'sveltekit';
  if ('astro' in deps || paths.some((p) => /^astro\.config\.[cm]?[jt]s$/.test(p))) return 'astro';
  if ('nuxt' in deps || paths.some((p) => /^nuxt\.config\.[cm]?[jt]s$/.test(p))) return 'nuxt';
  if ('vite' in deps || paths.some((p) => /^vite\.config\.[cm]?[jt]s$/.test(p))) return 'vite';
  if (isWordPressPlugin(files) || isWordPressTheme(files)) return 'wordpress';
  if (!pkg && 'index.html' in files) return 'static';
  return 'unknown';
}

/** A root-level PHP file with a "Plugin Name:" header. */
export function wordPressPluginFile(files: FileTree): string | null {
  for (const [path, content] of Object.entries(files)) {
    if (!path.includes('/') && path.endsWith('.php') && typeof content === 'string' && /^[ \t/*#@]*Plugin Name:/im.test(content)) return path;
  }
  return null;
}

function isWordPressPlugin(files: FileTree): boolean {
  return wordPressPluginFile(files) !== null;
}

function isWordPressTheme(files: FileTree): boolean {
  const css = files['style.css'];
  return typeof css === 'string' && /^[ \t/*#@]*Theme Name:/im.test(css);
}

/** A zip's entries as a file tree, with the same exclusions as a directory (node_modules, .git, check files, …). */
export function filesFromZip(buf: Buffer): FileTree {
  const files: FileTree = {};
  // macOS "Compress" adds a __MACOSX/ sibling; drop it before looking for a common root folder.
  const entries = readZip(buf).filter((e) => !e.path.startsWith('__MACOSX/'));
  for (const { path, data } of stripCommonRoot(entries)) {
    const clean = normalize(path);
    const parts = clean.split('/');
    if (parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d) || d === '__MACOSX')) continue;
    const file = parts.at(-1)!;
    if (IGNORED_FILES.test(file) || file === '.DS_Store') continue;
    if (data.length > MAX_FILE_BYTES) throw new Error(`file too large: ${clean}`);
    files[clean] = isText(data) ? data.toString('utf8') : { base64: data.toString('base64') };
  }
  return files;
}

function parseFileTree(value: unknown): FileTree {
  const tree = (value as { files?: unknown })?.files ?? value;
  if (!tree || typeof tree !== 'object') throw new Error('JSON project must be an object of path → contents');
  const files: FileTree = {};
  for (const [path, content] of Object.entries(tree)) {
    if (typeof content === 'string') files[normalize(path)] = content;
    else if (content && typeof (content as { base64?: unknown }).base64 === 'string') {
      files[normalize(path)] = { base64: (content as { base64: string }).base64 };
    } else throw new Error(`JSON project: invalid contents for ${path}`);
  }
  return files;
}

async function readDirectory(root: string): Promise<FileTree> {
  const files: FileTree = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && !IGNORED_FILES.test(entry.name)) {
        const buf = await readFile(full);
        if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large: ${relative(root, full)}`);
        files[relative(root, full).split(sep).join('/')] = isText(buf) ? buf.toString('utf8') : { base64: buf.toString('base64') };
      }
    }
  }
  await walk(root);
  return files;
}

function normalize(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (clean.split('/').includes('..')) throw new Error(`path escapes project root: ${path}`);
  return clean;
}
