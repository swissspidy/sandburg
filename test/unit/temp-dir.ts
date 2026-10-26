/**
 * Temporary directories for unit tests, removed when the test file's process exits, passed or failed,
 * with whatever was written into them after the tests ended (the host's preload lists are written on
 * a 2 s timer). Tests left ~40 directories, 16 MB, in the system's temp directory per unit run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A new directory under the system's temp directory, named `prefix` and a random suffix. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
