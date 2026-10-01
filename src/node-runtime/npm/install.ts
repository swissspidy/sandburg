/**
 * An npm install in the browser (opt-in: `--install-in browser`): resolves the project's dependency
 * tree (resolve.ts), fetches and unpacks the tarballs, and makes the same changes for the browser
 * runtime as the host's installer (install-rules.ts): WebAssembly bindings for napi-rs packages,
 * WebAssembly builds in place of native code, SWC's WebAssembly build for Next.js, source patches,
 * and the index of package binaries. The result is the files of node_modules, in memory.
 */
import semver from 'semver';
import { NEXT_SWC_WASM, SOURCE_PATCHES, WASM_BUILDS, wasiBindings } from '../../adapters/node/install-rules.ts';
import type { Registry } from './registry.ts';
import { resolveTree, type Placed, type RootPackage } from './resolve.ts';

export interface BrowserInstallPart {
  /** The package's directory in the project ('' for the root, 'client', 'server', …). */
  dir: string;
  packageJson: RootPackage;
  lockfile: string | null;
  extra: Record<string, string>;
}

export interface BrowserInstall {
  /** node_modules files, by path relative to the project ("node_modules/react/index.js", "client/node_modules/…"). */
  files: Map<string, Uint8Array>;
  /** The project's direct dependencies and the versions installed (root package). */
  resolved: Record<string, string>;
  packages: number;
  /** Whether the root package's lockfile decided its tree. */
  lockfile: boolean;
}

const CONCURRENCY = 16;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** A package with its own dependencies inside it: a sub-tree resolved alone, placed under `at`. */
async function isolated(registry: Registry, name: string, range: string, at: string): Promise<Placed[]> {
  const tree = await resolveTree({ dependencies: { [name]: range } }, registry);
  const out: Placed[] = [];
  for (const p of tree.values()) {
    const rest = p.path.slice('node_modules/'.length);
    const path = rest === name ? at : `${at}/node_modules/${rest}`;
    out.push({ ...p, path });
  }
  return out;
}

export async function installInBrowser(parts: BrowserInstallPart[], registry: Registry, log: (line: string) => void): Promise<BrowserInstall> {
  const files = new Map<string, Uint8Array>();
  let packages = 0;
  let resolved: Record<string, string> = {};
  let lockfile = false;
  const started = performance.now();
  for (const part of parts) {
    const prefix = part.dir ? `${part.dir}/` : '';
    const used = { lockfile: false };
    const tree = await resolveTree(part.packageJson, registry, { lockfile: part.lockfile, extra: part.extra, log, used });
    if (!part.dir) lockfile = used.lockfile;
    const placed = [...tree.values()];

    // WebAssembly bindings of napi-rs packages (rolldown, Tailwind's oxide, …), at the top.
    const wanted: Record<string, string> = {};
    const candidates: Record<string, string> = {};
    for (const p of placed) {
      const found = wasiBindings(p.optionalDependencies);
      Object.assign(wanted, found.listed);
      Object.assign(candidates, found.candidates);
    }
    for (const [name, range] of Object.entries(candidates)) {
      if (name in wanted) continue;
      const packument = await registry.packument(name);
      if (packument && semver.maxSatisfying(Object.keys(packument.versions), range)) wanted[name] = range;
    }
    for (const [name, range] of Object.entries(wanted)) {
      if (tree.has(`node_modules/${name}`)) continue;
      placed.push(...(await isolated(registry, name, range, `node_modules/${name}`)));
    }

    // WebAssembly builds in place of native code, inside each copy of the package.
    const swaps: { p: Placed; build: (typeof WASM_BUILDS)[number] }[] = [];
    for (const p of [...placed]) {
      const build = WASM_BUILDS.find((b) => b.name === p.name && b.applies(p.version));
      if (!build) continue;
      swaps.push({ p, build });
      placed.push(...(await isolated(registry, build.wasm, p.version, `${p.path}/node_modules/${build.wasm}`)));
    }

    await mapLimit(placed, CONCURRENCY, async (p) => {
      for (const f of await registry.files(p)) files.set(`${prefix}${p.path}/${f.path}`, f.data);
    });
    packages += placed.length;

    const encoder = new TextEncoder();
    for (const { p, build } of swaps) {
      const main = `${prefix}${p.path}/${build.file}`;
      if (!files.has(main)) continue;
      files.set(main, encoder.encode(build.shim));
      for (const [file, shim] of Object.entries(build.also ?? {})) files.set(`${prefix}${p.path}/${file}`, encoder.encode(shim));
      log(`${build.name} ${p.version}: using ${build.wasm}`);
    }
    // Next.js loads SWC's WebAssembly build from next/wasm (NEXT_TEST_WASM).
    const swcFrom = `${prefix}${NEXT_SWC_WASM.from}/`;
    if (files.has(`${prefix}node_modules/next/package.json`)) {
      for (const [path, data] of [...files]) if (path.startsWith(swcFrom)) files.set(`${prefix}${NEXT_SWC_WASM.to}/${path.slice(swcFrom.length)}`, data);
    }
    // Source patches (see install-rules.ts), applied once here instead of per transform on the host.
    const decoder = new TextDecoder();
    for (const [path, data] of files) {
      const patches = SOURCE_PATCHES.filter((patch) => patch.file.test(path));
      if (!patches.length) continue;
      let text = decoder.decode(data);
      for (const patch of patches) text = text.replace(patch.from, patch.to);
      files.set(path, encoder.encode(text));
    }
    // The shell's index of package binaries (node_modules/.bin), as the host writes it.
    const bins: Record<string, string> = {};
    for (const p of tree.values()) {
      if (!/^node_modules\/(@[^/]+\/)?[^/]+$/.test(p.path) || !p.bin) continue;
      const entries = typeof p.bin === 'string' ? { [p.name.split('/').pop()!]: p.bin } : p.bin;
      for (const [bin, file] of Object.entries(entries)) bins[bin] ??= `${p.path}/${file.replace(/^\.\//, '')}`;
    }
    files.set(`${prefix}node_modules/.sandburg-bins.json`, encoder.encode(JSON.stringify(bins)));

    if (!part.dir) {
      resolved = Object.fromEntries(Object.keys({ ...part.packageJson.dependencies, ...part.packageJson.devDependencies }).map((n) => [n, tree.get(`node_modules/${n}`)?.version ?? '']));
    }
  }
  log(`installed ${packages} packages in the browser in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  return { files, resolved, packages, lockfile };
}

/**
 * node_modules as one block of shared memory and an index (path -> [offset, length]): the runtime
 * and every thread it starts read installed files from it, without copies and without asking each
 * other (a thread's parent may be blocked).
 */
export function packFiles(files: Map<string, Uint8Array>): { sab: SharedArrayBuffer; index: Record<string, [number, number]> } {
  // A file at two paths (SWC's WebAssembly build, copied into next/wasm) is stored once.
  const offsets = new Map<Uint8Array, number>();
  let size = 0;
  for (const data of files.values()) {
    if (offsets.has(data)) continue;
    offsets.set(data, size);
    size += data.length;
  }
  const sab = new SharedArrayBuffer(size);
  const bytes = new Uint8Array(sab);
  for (const [data, at] of offsets) bytes.set(data, at);
  const index: Record<string, [number, number]> = {};
  for (const [path, data] of files) index[path] = [offsets.get(data)!, data.length];
  return { sab, index };
}
