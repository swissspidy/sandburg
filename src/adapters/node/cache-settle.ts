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
