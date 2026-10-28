/**
 * A rename that replaces a file, tried again while Windows refuses it: there a rename over a file
 * another handle has open (a reader in another process, a virus scanner, an indexer) fails with
 * EPERM, EACCES or EBUSY until that handle closes.
 */
import { rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

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
