/**
 * Whether a dev server's cache is settled enough to store (see dispose in browser.ts), and, when it is
 * not, why: a seed run that ends without storing its cache says so (one line in its run's console).
 */
import type { CacheEntry } from '../../node-runtime/cache-tree.ts';

/** Whether two looks at a cache found the same files, none written in between (same sizes and mtimes). */
export function sameFiles(a: CacheEntry[], b: CacheEntry[] | undefined): boolean {
  return !!b && a.length === b.length && a.every(([path, size, mtimeMs], i) => b[i][0] === path && b[i][1] === size && b[i][2] === mtimeMs);
}

/**
 * Why a cache that waits for `waitFor` is not settled at a look (`next`, after `last`), or null when it
 * is: every file there, none mid-write (webpack writes each pack under <name>_, then renames it), and
 * the same files as at the last look. A look that got no answer (it gives up after 5 s) is null.
 */
export function unsettled(waitFor: string[], next: CacheEntry[] | null, last: CacheEntry[] | null | undefined): string | null {
  if (!next) return 'a look at it got no answer';
  const names = new Set(next.map(([path]) => path));
  const missing = waitFor.filter((f) => !names.has(f));
  if (missing.length) return `no ${missing.join(', ')}`;
  const writing = next.filter(([path]) => path.endsWith('_')).map(([path]) => path);
  if (writing.length) return `${writing.join(', ')} still being written`;
  if (!sameFiles(next, last ?? undefined)) return 'its files were still changing';
  return null;
}

/** How long a read of a cache's bytes may take: 5 s, and half a second more for each MB the last look listed. */
export function readTimeoutMs(files: CacheEntry[]): number {
  const bytes = files.reduce((n, [, size]) => n + size, 0);
  return 5000 + Math.ceil(bytes / (1 << 20)) * 500;
}

/** A look at a cache: its files, and its bytes when asked for (null: no answer within `timeoutMs`). */
export type CacheLook<T extends { files: CacheEntry[] }> = (bytes: boolean, timeoutMs: number) => Promise<T | null>;

/**
 * Waits for a cache that waits for `waitFor` (a seed's) to settle (see unsettled), then reads its bytes:
 * the snapshot read, or why there is none once `deadlineMs` passed. A read that got no answer (its
 * worker busy with the dev server and webpack's packing), or that found the files changed (the tree
 * looked settled in a quiet moment before the next write), goes back to waiting: neither gives up
 * before the deadline. One look every `intervalMs`.
 */
export async function settledCache<T extends { files: CacheEntry[] }>(
  waitFor: string[],
  look: CacheLook<T>,
  { deadlineMs = 40_000, intervalMs = 250, now = () => performance.now(), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<{ cache: T; why?: undefined } | { cache?: undefined; why: string }> {
  const deadline = now() + deadlineMs;
  let last = (await look(false, 5000))?.files ?? null;
  let why = 'it was not looked at';
  while (now() < deadline) {
    await sleep(intervalMs);
    const next = (await look(false, 5000))?.files ?? null;
    const unsettledWhy = unsettled(waitFor, next, last);
    last = next;
    if (unsettledWhy !== null) {
      why = unsettledWhy;
      continue;
    }
    const cache = await look(true, readTimeoutMs(next!));
    if (!cache) {
      why = 'reading its files got no answer';
      continue;
    }
    // One that changed again as its bytes were read is not stored: it may hold a pack webpack was still writing.
    if (!sameFiles(cache.files, next!)) {
      why = 'it changed as its files were read';
      last = cache.files;
      continue;
    }
    return { cache };
  }
  return { why: `after ${deadlineMs / 1000} s, ${why}` };
}
