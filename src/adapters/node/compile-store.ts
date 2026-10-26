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
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CompileStore } from './compile.ts';
import { tmpSuffix } from './install.ts';

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
      const file = fileOf(dir, key);
      const tmp = `${file}.${tmpSuffix()}.tmp`;
      return mkdir(dirname(file), { recursive: true })
        .then(() => writeFile(tmp, out))
        .then(() => rename(tmp, file))
        .then(() => {
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
 * Removes the compiles of other versions (dir's siblings v<N>) that have not changed for a day (another
 * Sandburg process may still use one), and the oldest of `dir` beyond `max` bytes, down to three
 * quarters of it.
 */
export async function sweepCompiles(dir: string, max = COMPILED_MAX, now = Date.now()): Promise<void> {
  const root = dirname(dir);
  for (const version of await readdir(root).catch(() => [] as string[])) {
    if (version === basename(dir) || !/^v\d+(-[0-9a-f]+)?$/.test(version)) continue;
    const s = await stat(join(root, version)).catch(() => null);
    if (s && now - s.mtimeMs > 24 * 3600_000) await rm(join(root, version), { recursive: true, force: true }).catch(() => {});
  }
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
