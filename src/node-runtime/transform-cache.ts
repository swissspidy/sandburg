/**
 * A project's cache of a dev server plugin's transforms, kept with Vite's own cache
 * (node_modules/.vite, a dev-cache directory: see DEV_CACHE_DIRS in adapters/node/index.ts) so that
 * the project's next run starts from it. A dev server's plugin that compiles each module with Babel
 * (vite-plugin-solid: 1.2 s of a warm SolidStart run's thread) looks a module up here before it
 * compiles it, and records what it compiled (see SOURCE_PATCHES in adapters/node/install-rules.ts).
 *
 * An entry is found by the module's id and environment and holds the source it was compiled from:
 * it is used only for that exact source. Everything else the output depends on (the plugin's and
 * Babel's versions and options, the project's configuration) is the same for every run that gets
 * this cache: the host gives a run only the caches of the same project and install (its dev-cache
 * key is a digest of both). A run can plant entries only in its own project's cache.
 */
import type { Vfs } from './vfs.ts';

interface TransformResult {
  code: string;
  map?: unknown;
}

export interface TransformCache {
  get(scope: string, id: string, ssr: boolean, source: string): TransformResult | null;
  set(scope: string, id: string, ssr: boolean, source: string, result: TransformResult): void;
  /** A plugin's own cache file (rollup's cache of Nitro's server build), by name: its text, or null. */
  getFile(scope: string, name: string): string | null;
  setFile(scope: string, name: string, text: string): void;
  /**
   * Before the cache is kept (the run's dev-server caches are read for the next run): entries this
   * run neither used nor added are dropped, so that a cache does not keep compiles of sources the
   * project no longer has (files edited during the run). Not when the run did not use the cache.
   */
  prune(): void;
}

/** Where a plugin finds the cache: a global under a registered symbol, so that no app name collides with it. */
export const TRANSFORM_CACHE = Symbol.for('sandburg.transformCache');

/** Sources larger than this are compiled every time (the cache's size stays near the project's). */
const MAX_SOURCE = 1 << 20;

/**
 * Whether a module is worth an entry: a file of the project or its packages. Not a virtual module
 * (SolidStart's /@manifest/ssr/<timestamp>/assets would add an entry every run).
 */
const cacheable = (vfs: Vfs, id: string, source: string) => source.length <= MAX_SOURCE && id.startsWith('/') && vfs.kind(id) === 'file';

interface Entry extends TransformResult {
  id: string;
  ssr: boolean;
  source: string;
}

/**
 * A file name for an entry: FNV-1a hashes of its key and of its source, so that the variants of a
 * module (SolidStart compiles a route again for each ?pick= of it, under the same id) each keep
 * an entry. A collision is only a miss: an entry holds its key and source.
 */
function fileName(scope: string, id: string, ssr: boolean, source: string): string {
  const fnv = (text: string, h: number) => {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  return `${fnv(`${scope}\0${id}\0${ssr ? 1 : 0}`, 0x811c9dc5)}${fnv(source, 0x811c9dc5)}.json`;
}

export function createTransformCache(vfs: Vfs, cwd: () => string): TransformCache {
  const root = () => `${cwd()}/node_modules/.vite/sandburg-transforms`;
  const dir = (scope: string) => `${root()}/${scope.replace(/[^\w.-]/g, '_')}`;
  /** Entries this run used or added. */
  const used = new Set<string>();
  return {
    get(scope, id, ssr, source) {
      if (!cacheable(vfs, id, source)) return null;
      try {
        const file = `${dir(scope)}/${fileName(scope, id, ssr, source)}`;
        const entry = JSON.parse(new TextDecoder().decode(vfs.read(file))) as Entry;
        if (entry.id !== id || entry.ssr !== ssr || entry.source !== source || typeof entry.code !== 'string') return null;
        used.add(file);
        return entry.map === undefined ? { code: entry.code } : { code: entry.code, map: entry.map };
      } catch {
        return null;
      }
    },
    set(scope, id, ssr, source, result) {
      if (typeof result?.code !== 'string' || !cacheable(vfs, id, source)) return;
      try {
        const entry: Entry = { id, ssr, source, code: result.code, map: result.map ?? undefined };
        const file = `${dir(scope)}/${fileName(scope, id, ssr, source)}`;
        vfs.mkdir(dir(scope), true);
        vfs.write(file, new TextEncoder().encode(JSON.stringify(entry)));
        used.add(file);
      } catch {
        // A cache that cannot be written is no cache: the plugin compiles as before.
      }
    },
    getFile(scope, name) {
      const file = `${dir(scope)}/${name.replace(/[^\w.-]/g, '_')}`;
      try {
        const text = new TextDecoder().decode(vfs.read(file));
        used.add(file);
        return text;
      } catch {
        return null;
      }
    },
    setFile(scope, name, text) {
      const file = `${dir(scope)}/${name.replace(/[^\w.-]/g, '_')}`;
      try {
        vfs.mkdir(dir(scope), true);
        vfs.write(file, new TextEncoder().encode(text));
        used.add(file);
      } catch {
        // as set()
      }
    },
    prune() {
      if (!used.size) return;
      try {
        for (const scope of vfs.readdir(root())) {
          for (const name of vfs.readdir(`${root()}/${scope}`)) if (!used.has(`${root()}/${scope}/${name}`)) vfs.unlink(`${root()}/${scope}/${name}`);
        }
      } catch {
        // nothing kept yet
      }
    },
  };
}
