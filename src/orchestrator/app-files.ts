/**
 * The app's files a run collects (RunOptions.collectFiles) and `sandburg run --save-files` writes
 * into the project. They come from the page, so the host keeps only what it asked for: paths that
 * match the pattern, relative and normalized, outside node_modules, dot directories and .git, and at
 * most APP_FILES_MAX files and APP_FILES_MAX_BYTES in all. The writer writes no file through a
 * symlink.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileContent, FileTree } from '../types.ts';

/** The most files a run collects. */
const APP_FILES_MAX = 1000;
/** The most bytes a run collects, in all (a dev-server cache's limit, ADR 0040). */
const APP_FILES_MAX_BYTES = 256 * 1024 * 1024;

/** Why `path` is not one to collect or write (see the module's comment), or null. */
export function appFilePathProblem(path: string): string | null {
  if (path === '') return 'empty';
  if (path.includes('\\') || path.includes('\0') || /^[a-z]:/i.test(path)) return 'not a POSIX path';
  if (path.startsWith('/')) return 'absolute';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'not normalized';
  if (segments.some((s) => s.toLowerCase() === '.git')) return 'in .git';
  // As the runtime looks (node-runtime/worker.ts' read-tree): outside node_modules and dot directories.
  if (segments.slice(0, -1).some((s) => s === 'node_modules' || s.startsWith('.'))) return 'in node_modules or a dot directory';
  return null;
}

/** The files of `value` (what the page returned) whose path matches `match` and is one to collect, within the limits. */
export function appFilesFrom(value: unknown, match: string, limits = { files: APP_FILES_MAX, bytes: APP_FILES_MAX_BYTES }): FileTree {
  if (typeof value !== 'object' || value === null) return {};
  const pattern = new RegExp(match);
  const kept: [string, FileContent][] = [];
  let bytes = 0;
  for (const [path, content] of Object.entries(value)) {
    const size = contentSize(content);
    if (size === null || !pattern.test(path) || appFilePathProblem(path) !== null) continue;
    if (kept.length === limits.files || bytes + size > limits.bytes) break;
    bytes += size;
    kept.push([path, content as FileContent]);
  }
  return Object.fromEntries(kept);
}

function contentSize(content: unknown): number | null {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (typeof content === 'object' && content !== null && typeof (content as { base64?: unknown }).base64 === 'string') {
    return Math.floor(((content as { base64: string }).base64.length * 3) / 4);
  }
  return null;
}

/**
 * Writes `files` under `root`, each to a new file renamed into place. A file whose path is not one
 * to write, or goes through a symlink or something else that is not a directory, or is there and is
 * not a regular file, is not written: its path is in the list returned.
 */
export async function writeAppFiles(root: string, files: FileTree): Promise<string[]> {
  const skipped: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const file = appFilePathProblem(path) === null ? await target(root, path) : null;
    if (!file) {
      skipped.push(path);
      continue;
    }
    const temp = `${file}.sandburg-${randomBytes(6).toString('hex')}`;
    // O_EXCL and O_NOFOLLOW: a new file of this write's own, never one a symlink points at.
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.writeFile(typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));
      await handle.close();
      await rename(temp, file);
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(temp, { force: true });
      throw err;
    }
  }
  return skipped;
}

/** Where `path` goes under `root`, its directories made: null if one of them, or the file, is not what it should be. */
async function target(root: string, path: string): Promise<string | null> {
  const segments = path.split('/');
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    if (!(await lstat(dir)).isDirectory()) return null;
  }
  const file = join(dir, segments.at(-1)!);
  const st = await lstat(file).catch(() => null);
  return st && !st.isFile() ? null : file;
}
