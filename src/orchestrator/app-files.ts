/**
 * The app's files a run collects (RunOptions.collectFiles) and `sandburg run --save-files` writes
 * into the project. They come from the page, so the host keeps only what it asked for: paths that
 * match the pattern, relative and normalized, outside node_modules, dot directories and .git, and,
 * all or nothing, at most APP_FILES_MAX files and APP_FILES_MAX_BYTES in all (a database is never
 * written without its journal). The writer writes no file through a symlink.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import type { FileContent, FileTree } from '../types.ts';

/** The most files a run collects. */
const APP_FILES_MAX = 1000;
/** The most bytes a run collects, in all (a dev-server cache's limit, ADR 0040). */
const APP_FILES_MAX_BYTES = 256 * 1024 * 1024;
/** The longest path looked at; longer ones are not matched against the pattern. */
const PATH_MAX = 4096;

/** Why `path` is not one to collect or write (see the module's comment), or null. */
export function appFilePathProblem(path: string): string | null {
  if (path === '') return 'empty';
  if (path.length > PATH_MAX) return 'too long';
  if (path.includes('\\') || path.includes('\0') || path.includes(':')) return 'not a POSIX path';
  if (path.startsWith('/')) return 'absolute';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'not normalized';
  // Names some file systems read as another (trailing dots and spaces, 8.3 short names), as git refuses them.
  if (segments.some((s) => s.endsWith('.') || s.endsWith(' ') || /~\d/.test(s))) return 'not a portable name';
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.includes('.git')) return 'in .git';
  // As the runtime looks (node-runtime/worker.ts' read-tree): outside node_modules and dot directories.
  if (lower.slice(0, -1).some((s) => s === 'node_modules' || s.startsWith('.'))) return 'in node_modules or a dot directory';
  return null;
}

/**
 * The files of `value` (what the page returned) whose path matches `match` and is one to collect;
 * none, and why, if they are over the limits.
 */
export function appFilesFrom(value: unknown, match: string, limits = { files: APP_FILES_MAX, bytes: APP_FILES_MAX_BYTES }): { files: FileTree; refused?: string } {
  if (typeof value !== 'object' || value === null) return { files: {} };
  const pattern = new RegExp(match);
  const kept: [string, FileContent][] = [];
  let bytes = 0;
  let seen = 0;
  for (const path in value) {
    if (!Object.hasOwn(value, path)) continue;
    if (++seen > limits.files * 10) return { files: {}, refused: `more than ${limits.files * 10} entries` };
    const content = (value as Record<string, unknown>)[path];
    const size = contentSize(content);
    if (size === null || path.length > PATH_MAX || !pattern.test(path) || appFilePathProblem(path) !== null) continue;
    kept.push([path, content as FileContent]);
    bytes += size;
  }
  if (kept.length > limits.files) return { files: {}, refused: `${kept.length} files match, more than ${limits.files}` };
  if (bytes > limits.bytes) return { files: {}, refused: `${bytes} bytes match, more than ${limits.bytes}` };
  return { files: Object.fromEntries(kept) };
}

function contentSize(content: unknown): number | null {
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (typeof content === 'object' && content !== null && typeof (content as { base64?: unknown }).base64 === 'string') {
    return Math.floor(((content as { base64: string }).base64.length * 3) / 4);
  }
  return null;
}

/**
 * Writes `files` under `root`, each to a new file in its directory renamed into place, with the
 * mode of the file it replaces. A file whose path is not one to write, goes through a symlink or
 * something else that is not a directory, is there and is not a regular file, or fails to be
 * written, is not written: it is in the list returned, with why.
 */
export async function writeAppFiles(root: string, files: FileTree): Promise<{ path: string; reason: string }[]> {
  const skipped: { path: string; reason: string }[] = [];
  for (const [path, content] of Object.entries(files)) {
    try {
      const reason = appFilePathProblem(path) === null ? await writeAppFile(root, path, content) : 'invalid path';
      if (reason) skipped.push({ path, reason });
    } catch (err) {
      skipped.push({ path, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message });
    }
  }
  return skipped;
}

/** Writes one file (see writeAppFiles): null, or why it was not written. */
async function writeAppFile(root: string, path: string, content: FileContent): Promise<string | null> {
  const segments = path.split('/');
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    const st = await lstat(dir);
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isDirectory()) return 'not a directory';
  }
  const file = join(dir, segments.at(-1)!);
  const st = await lstat(file).catch(() => null);
  if (st?.isSymbolicLink()) return 'symlink';
  if (st && !st.isFile()) return 'not a regular file';
  const temp = join(dir, `.sb-${randomBytes(4).toString('hex')}`);
  // O_EXCL and O_NOFOLLOW: a new file of this write's own, never one a symlink points at.
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.writeFile(typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));
    await handle.close();
    if (st) await chmod(temp, st.mode & 0o7777);
    await renameRetrying(temp, file);
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
    throw err;
  }
  return null;
}

/** Errors a rename gets on Windows while another program (a virus scanner, an indexer) has the file open. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Renames `from` to `to`, again after 50, 100 and 200 ms while the error is one of BUSY; never removes `to` first. */
export async function renameRetrying(from: string, to: string, renameFile: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  for (const wait of [50, 100, 200, null]) {
    try {
      return await renameFile(from, to);
    } catch (err) {
      if (wait === null || !BUSY.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await sleep(wait);
    }
  }
}
