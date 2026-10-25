/**
 * Vite's bundle of the project's config file, kept from the project's last run (ADR NNNN). Every
 * start of a Vite dev server bundles vite.config.ts and what it imports from the project, on the
 * program's thread: with esbuild's WebAssembly build (Vite 5-7: ~0.3 s of a warm start, most of it
 * esbuild's Go code starting and running cold) or rolldown's (Vite 8). The bundle is a function of
 * the files it bundled, the TypeScript configuration next to them and the installed packages its
 * imports resolve to; a run of the same project and install (the transform cache's scope, see
 * transform-cache.ts) has the same, unless a file changed: an entry holds the text of every file it
 * depends on, and is used only while each is as it was.
 *
 * Vite's `bundleConfigFile` asks here (SOURCE_PATCHES in adapters/node/install-rules.ts).
 */
import type { TransformCache } from './transform-cache.ts';
import type { Vfs } from './vfs.ts';

/** Where Vite's patched bundleConfigFile finds the hook (a registered symbol: no app name collides with it). */
export const CONFIG_BUNDLES = Symbol.for('sandburg.configBundles');

interface Bundle {
  code: string;
  dependencies: string[];
  nativeIncompatibilities?: unknown[];
}

interface Entry {
  fileName: string;
  isESM: boolean;
  cwd: string;
  /** Each file the bundle depends on, by absolute path: its text, or null where there was none. */
  inputs: Record<string, string | null>;
  bundle: Bundle;
}

/** Files that change how a bundler reads the files next to (or below) them. */
const SETTINGS = ['package.json', 'tsconfig.json', 'jsconfig.json'];
/** The config of an import.meta.resolve user registers a module hook as it is bundled (Vite 8): not kept. */
const RESOLVE_HOOK = '__vite_injected_original_import_meta_resolve';

const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** A bundle that JSON keeps as it is: the code, the files, and no findings to warn about (they are logged as they are found). */
function keepable(b: unknown): b is Bundle {
  if (!b || typeof b !== 'object') return false;
  const { code, dependencies, nativeIncompatibilities, ...rest } = b as Record<string, unknown>;
  return (
    typeof code === 'string' &&
    !code.includes(RESOLVE_HOOK) &&
    Array.isArray(dependencies) &&
    dependencies.every((d) => typeof d === 'string') &&
    (nativeIncompatibilities === undefined || (Array.isArray(nativeIncompatibilities) && nativeIncompatibilities.length === 0)) &&
    Object.keys(rest).length === 0
  );
}

export function createConfigBundles(vfs: Vfs, cache: TransformCache, cwd: () => string) {
  const text = (path: string) => {
    try {
      return vfs.kind(path) === 'file' ? new TextDecoder().decode(vfs.read(path)) : null;
    } catch {
      return null;
    }
  };
  /** What a bundle depends on: its files, and the settings files of their directories up to the project's. */
  const inputsOf = (bundle: Bundle, dir: string): Record<string, string | null> => {
    const inputs: Record<string, string | null> = {};
    for (const dep of bundle.dependencies) {
      const path = dep.startsWith('/') ? dep : `${dir}/${dep}`;
      inputs[path] = text(path);
      for (let d = path.slice(0, path.lastIndexOf('/')); d.startsWith(dir); d = d.slice(0, d.lastIndexOf('/'))) {
        for (const name of SETTINGS) inputs[`${d}/${name}`] ??= text(`${d}/${name}`);
        if (d === dir) break;
      }
    }
    return inputs;
  };
  return async (fileName: string, isESM: boolean, bundle: () => Promise<Bundle>): Promise<Bundle> => {
    const name = `${fnv(fileName)}-${isESM ? 'esm' : 'cjs'}.json`;
    const dir = cwd();
    try {
      const entry = JSON.parse(cache.getFile('vite-config', name) ?? 'null') as Entry | null;
      if (entry && entry.fileName === fileName && entry.isESM === isESM && entry.cwd === dir && Object.entries(entry.inputs).every(([path, was]) => text(path) === was)) {
        // A copy: Vite may change what it is given.
        return { ...entry.bundle, dependencies: [...entry.bundle.dependencies] };
      }
    } catch {
      // no entry, or not one of these: bundled as before
    }
    const result = await bundle();
    // Only a bundle of files that are all there (the config itself among them) is kept.
    if (keepable(result) && result.dependencies.length) {
      const inputs = inputsOf(result, dir);
      if (result.dependencies.every((d) => inputs[d.startsWith('/') ? d : `${dir}/${d}`] !== null)) {
        cache.setFile('vite-config', name, JSON.stringify({ fileName, isESM, cwd: dir, inputs, bundle: result } satisfies Entry));
      }
    }
    return result;
  };
}
