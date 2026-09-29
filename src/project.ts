/**
 * Project input: a directory or a JSON file tree. (Zip input is planned.)
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { FileTree, Framework, PackageJson, Project } from './types.ts';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.sandburg', '.turbo', '.cache']);
/** Sandburg's own check files are not part of the app. */
const IGNORED_FILES = /\.(spec|test)\.[cm]?[jt]sx?$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function loadProject(path: string): Promise<Project> {
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
  } else {
    throw new Error(`unsupported project input: ${path} (expected a directory or a .json file tree)`);
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
    contentHash: hashFiles(files),
  };
}

export function detectFramework(files: FileTree, pkg: PackageJson | null): Framework {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const paths = Object.keys(files);
  if ('next' in deps || paths.some((p) => /^next\.config\.[cm]?[jt]s$/.test(p))) return 'next';
  if ('vite' in deps || paths.some((p) => /^vite\.config\.[cm]?[jt]s$/.test(p))) return 'vite';
  if (!pkg && 'index.html' in files) return 'static';
  return 'unknown';
}

function hashFiles(files: FileTree): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    hash.update(path).update('\0').update(typeof content === 'string' ? content : content.base64).update('\0');
  }
  return hash.digest('hex');
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

function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}
