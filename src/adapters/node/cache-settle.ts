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

/** The longest a read of a cache's bytes may take (see readTimeoutMs). */
export const READ_TIMEOUT_MAX_MS = 15_000;

/**
 * How long a read of a cache's bytes may take: 5 s, and half a second more for each MB the last look
 * listed, at most READ_TIMEOUT_MAX_MS (a seed run's dispose phase is 60 s: index.ts's timeouts).
 */
export function readTimeoutMs(files: CacheEntry[]): number {
  const bytes = files.reduce((n, [, size]) => n + size, 0);
  return Math.min(READ_TIMEOUT_MAX_MS, 5000 + Math.ceil(bytes / (1 << 20)) * 500);
}

/** A look at a cache: its files, and its bytes when asked for (null: no answer within `timeoutMs`). */
export type CacheLook<T extends { files: CacheEntry[] }> = (bytes: boolean, timeoutMs: number) => Promise<T | null>;

/** A read of a cache's bytes is not started with less time left than this. */
export const MIN_READ_MS = 1000;

/** How long a run's dispose phase may take (the node adapter's timeouts.dispose, index.ts): a seed run stores its cache in it. */
export const DISPOSE_PHASE_MS = 60_000;

/** What a cache's upload leaves of the dispose phase, for the tab to close (session.ts) after its answer. */
export const SEND_MARGIN_MS = 3000;

/** An upload is not started with less time left than this. */
export const MIN_SEND_MS = 1000;

/**
 * How long the upload of a cache may take, for a dispose that started at `startedAt` (ms, the clock of
 * `now`): what is left of DISPOSE_PHASE_MS but SEND_MARGIN_MS, or null when that is under MIN_SEND_MS.
 */
export function sendTimeoutMs(startedAt: number, now: number): number | null {
  const left = DISPOSE_PHASE_MS - SEND_MARGIN_MS - (now - startedAt);
  return left >= MIN_SEND_MS ? left : null;
}

/** An error's first line (with its name), for a reason in one line. */
export const firstLine = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : String(e).split('\n')[0]);

/**
 * Waits for a cache that waits for `waitFor` (a seed's) to settle (see unsettled), then reads its bytes:
 * the snapshot read, or why there is none. A read that got no answer (its worker busy with the dev
 * server and webpack's packing), or that found the files changed (the tree looked settled in a quiet
 * moment before the next write), goes back to waiting. A look starts until `deadlineMs`; every look
 * and read is answered (or given up) by `graceMs` after that, so that with the hash and the upload
 * after it, the store ends well inside a seed run's 60 s dispose phase. One look every `intervalMs`. A
 * look that throws counts as one that got no answer.
 */
export async function settledCache<T extends { files: CacheEntry[] }>(
  waitFor: string[],
  look: CacheLook<T>,
  { deadlineMs = 40_000, graceMs = 5_000, intervalMs = 250, now = () => performance.now(), sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<{ cache: T; why?: undefined } | { cache?: undefined; why: string }> {
  const deadline = now() + deadlineMs;
  const answeredBy = deadline + graceMs;
  const left = () => answeredBy - now();
  // The last look's or read's error, if it threw: said with the reason it got no answer.
  let error: string | null = null;
  const lookAt = (bytes: boolean, timeoutMs: number) => {
    error = null;
    return look(bytes, Math.max(0, Math.min(timeoutMs, left()))).catch((e: unknown) => {
      error = firstLine(e);
      return null;
    });
  };
  const noAnswer = (why: string) => (error === null ? why : `${why} (${error})`);
  let last = (await lookAt(false, 5000))?.files ?? null;
  let why = 'it was not looked at';
  while (now() < deadline) {
    await sleep(intervalMs);
    const next = (await lookAt(false, 5000))?.files ?? null;
    const unsettledWhy = next === null ? noAnswer('a look at it got no answer') : unsettled(waitFor, next, last);
    last = next;
    if (unsettledWhy !== null) {
      why = unsettledWhy;
      continue;
    }
    if (left() < MIN_READ_MS) {
      why = 'no time was left to read its files';
      break;
    }
    const cache = await lookAt(true, readTimeoutMs(next!));
    if (!cache) {
      why = noAnswer('reading its files got no answer');
      continue;
    }
    // One that changed again as its bytes were read is not stored: it may hold a pack webpack was still
    // writing. The tree is waited for from what the read saw.
    if (!sameFiles(cache.files, next!)) {
      why = 'it changed as its files were read';
      last = cache.files;
      continue;
    }
    return { cache };
  }
  return { why: `after ${deadlineMs / 1000} s, ${why}` };
}
