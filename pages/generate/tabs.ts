/**
 * The tab a key moves to in a tablist of `count` tabs, from the tab at `index` (the WAI-ARIA tabs
 * pattern: arrows wrap around, Home and End go to the ends), or null for any other key.
 */
export function tabForKey(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
