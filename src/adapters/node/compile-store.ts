/**
 * Compiles of code the runtime sends the host (compile.ts), kept on disk under .sandburg/ as
 * transforms of installed files are. A second `sandburg run` of an app is a new process, whose
 * compile cache in memory starts empty: it compiled everything the runtime sent again (next dev's
 * chunks, Vite's config). The keys are the host's own, the digest of what it compiled, so a run
 * cannot store code for another, as in memory.
 *
 * Unlike transforms (one per package version), compiles accumulate with every app and edit: beyond
 * COMPILED_MAX bytes, the oldest go when a process starts, and again after every quarter of it a
 * process writes (a batch, or a long session, runs many apps in one process).
 */
import { readFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CompileStore } from './compile.ts';
import { writeSoon } from './file-writes.ts';

const COMPILED_MAX = 1 << 30;

const fileOf = (dir: string, key: string) => join(dir, key.slice(0, 2), `${key.slice(2)}.js`);

/** The disk store. Its write resolves once the compile is written, and any sweep it started is done (for tests; the host does not wait). */
export function diskCompileStore(dir: string, max = COMPILED_MAX): Pick<CompileStore, 'read'> & { write(key: string, out: string): Promise<void> } {
  let written = 0;
  let sweeping: Promise<void> | null = null;
  return {
    read(key) {
      try {
        return readFileSync(fileOf(dir, key), 'utf8');
      } catch {
        return undefined;
      }
    },
    write(key, out) {
      return writeSoon(fileOf(dir, key), out)
        .then((ok) => {
          // What was not written does not count toward the next sweep.
          if (!ok) return;
          written += Buffer.byteLength(out);
          if (written < max / 4 || sweeping) return sweeping ?? undefined;
          written = 0;
          sweeping = sweepCompiles(dir, max).finally(() => (sweeping = null));
          return sweeping;
        })
        .catch(() => {});
    },
  };
}

/**
 * Removes `dir`'s siblings of other versions (v<N>, v<N>-<hash>) that have not changed for a day
 * (another Sandburg process may still use one): nothing asks for them again. For the compiles here,
 * and for the installed files' transforms (transforms/v<TRANSFORM_VERSION>).
 */
export async function sweepOtherVersions(dir: string, now = Date.now()): Promise<void> {
  const root = dirname(dir);
  for (const version of await readdir(root).catch(() => [] as string[])) {
    if (version === basename(dir) || !/^v\d+(-[0-9a-f]+)?$/.test(version)) continue;
    const s = await stat(join(root, version)).catch(() => null);
    if (s && now - s.mtimeMs > DAY) await rm(join(root, version), { recursive: true, force: true }).catch(() => {});
  }
}
const DAY = 24 * 3600_000;

/** Dev caches, preload bundles and lists not written for this long are removed (sweepDevCaches). */
const DEV_CACHE_AGE = 14 * DAY;
/** Bytes of them kept: the oldest beyond it are removed. */
const DEV_CACHE_MAX = 8 * 2 ** 30;

/**
 * Removes the files of the dev-cache directory (a project's dev caches, up to 256 MB for each state
 * of its files; its compiles; an install's preload bundles and lists; a seed's marks) that were not
 * written for two weeks, and the oldest beyond `max` bytes, down to three quarters of it. Never one
 * written in the last day, which a run may be reading. What a run misses, it makes again: a cold
 * start, not a wrong result.
 */
export async function sweepDevCaches(dir: string, max = DEV_CACHE_MAX, maxAge = DEV_CACHE_AGE, now = Date.now()): Promise<void> {
  const files: { path: string; size: number; time: number }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (!s?.isFile()) continue;
    if (now - s.mtimeMs > maxAge) await rm(join(dir, name), { force: true }).catch(() => {});
    else files.push({ path: join(dir, name), size: s.size, time: s.mtimeMs });
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= max) return;
  files.sort((a, b) => a.time - b.time);
  for (const f of files) {
    if (total <= max * 0.75 || now - f.time <= DAY) break;
    await rm(f.path, { force: true }).catch(() => {});
    total -= f.size;
  }
}

/**
 * Removes the compiles of other versions (dir's siblings v<N>) that have not changed for a day (another
 * Sandburg process may still use one), and the oldest of `dir` beyond `max` bytes, down to three
 * quarters of it.
 */
export async function sweepCompiles(dir: string, max = COMPILED_MAX, now = Date.now()): Promise<void> {
  await sweepOtherVersions(dir, now);
  const files: { path: string; size: number; time: number }[] = [];
  for (const sub of await readdir(dir).catch(() => [] as string[])) {
    for (const name of await readdir(join(dir, sub)).catch(() => [] as string[])) {
      const s = await stat(join(dir, sub, name)).catch(() => null);
      if (s?.isFile()) files.push({ path: join(dir, sub, name), size: s.size, time: s.mtimeMs });
    }
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= max) return;
  files.sort((a, b) => a.time - b.time);
  for (const f of files) {
    if (total <= max * 0.75) break;
    await rm(f.path, { force: true }).catch(() => {});
    total -= f.size;
  }
}
