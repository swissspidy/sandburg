/**
 * Project input: a directory, a .zip archive, a JSON file tree, or a stored
 * snapshot ("snapshot:<id or prefix>").
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isText, manifestOf, snapshotId, type SnapshotStore } from './store.ts';
import type { FileTree, PackageJson, Project } from './types.ts';
import { detectFramework } from './framework.ts';
import { readZip, stripCommonRoot } from './zip.ts';
import { isWorkspace, workspacePatterns } from './workspaces.ts';

export { detectFramework };

/** Never part of the app's sources, at any depth (installs, history, tools' caches and output). */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.sandburg', '.next', '.turbo', '.cache']);
/** Build output: left out at the project's root only (`src/build/` and `packages/ui/dist/` may be source). */
const IGNORED_ROOT_DIRS = new Set(['dist', 'build']);
/** Whether a directory, `depth` directories below the project's root (0: at the root), is left out. */
const ignoredDir = (name: string, depth: number) => IGNORED_DIRS.has(name) || (depth === 0 && IGNORED_ROOT_DIRS.has(name));
/** Sandburg's own check files are not part of the app. */
const IGNORED_FILES = /\.(spec|test)\.[cm]?[jt]sx?$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Loads a project from a directory, a .zip, a JSON file tree or "snapshot:<id>" (from `store`). */
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
    // A package of a monorepo runs in its monorepo, whose workspaces it uses (ADR 0064).
    const root = await workspaceRoot(abs);
    if (root) {
      const project = projectFromFiles(await readDirectory(root), { name: basename(abs), path: root });
      return { ...project, name: basename(abs), app: relative(root, abs).split(sep).join('/') };
    }
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

/**
 * The monorepo `dir` is a workspace package of: the nearest directory above it with workspaces
 * (package.json `workspaces`, pnpm-workspace.yaml), if they name `dir`. Null for anything else,
 * `dir` itself being a monorepo's root included.
 */
async function workspaceRoot(dir: string): Promise<string | null> {
  if (await workspaceManifest(dir)) return null;
  for (let up = dirname(dir); ; up = dirname(up)) {
    const found = await workspaceManifest(up);
    if (found) {
      const rel = relative(up, dir).split(sep).join('/');
      return isWorkspace(rel, found) && (await stat(join(dir, 'package.json')).then((s) => s.isFile(), () => false)) ? up : null;
    }
    if (up === dirname(up)) return null;
  }
}

/** The workspace patterns of a directory's package.json or pnpm-workspace.yaml, or null if it declares none. */
async function workspaceManifest(dir: string): Promise<string[] | null> {
  const files: FileTree = {};
  for (const file of ['package.json', 'pnpm-workspace.yaml']) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (text !== null) files[file] = text;
  }
  let pkg: PackageJson | null = null;
  try {
    pkg = typeof files['package.json'] === 'string' ? (JSON.parse(files['package.json']) as PackageJson) : null;
  } catch {
    pkg = null;
  }
  return workspacePatterns(files, pkg);
}

/** A project from a file tree in memory: its package.json, framework and snapshot id. */
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

/** A zip's entries as a file tree, with the same exclusions as a directory (node_modules, .git, check files, …). */
function filesFromZip(buf: Buffer): FileTree {
  const files: FileTree = {};
  // macOS "Compress" adds a __MACOSX/ sibling; drop it before looking for a common root folder.
  const entries = readZip(buf).filter((e) => !e.path.startsWith('__MACOSX/'));
  for (const { path, data } of stripCommonRoot(entries)) {
    const clean = normalize(path);
    const parts = clean.split('/');
    if (parts.slice(0, -1).some((d, depth) => ignoredDir(d, depth) || d === '__MACOSX')) continue;
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
  async function walk(dir: string, depth: number): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDir(entry.name, depth)) await walk(full, depth + 1);
      } else if (entry.isFile() && !IGNORED_FILES.test(entry.name)) {
        const buf = await readFile(full);
        if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large: ${relative(root, full)}`);
        files[relative(root, full).split(sep).join('/')] = isText(buf) ? buf.toString('utf8') : { base64: buf.toString('base64') };
      }
    }
  }
  await walk(root, 0);
  return files;
}

function normalize(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (clean.split('/').includes('..')) throw new Error(`path escapes project root: ${path}`);
  return clean;
}
