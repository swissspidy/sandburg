/**
 * Which package versions an install has, and where they go in node_modules, as npm decides it.
 *
 * - With a package-lock.json (v2/v3): its tree, as npm ci installs it.
 * - Without: each dependency's range resolves to the registry's `latest` version if that satisfies
 *   it, otherwise the newest version that does (as npm does). A package goes to the top of
 *   node_modules unless another version of it is there already, then into its dependent's
 *   node_modules. A dependency that a parent's node_modules already provides in a satisfying
 *   version is shared. Breadth first, so a project's own dependencies come to the top.
 *
 * Optional dependencies are left out (the host installs with --omit=optional too: their native
 * builds are replaced by WebAssembly builds, see install-rules.ts), and so are bundled
 * dependencies (they come inside their package's tarball). Peer dependencies are installed, as
 * npm 7 and later do, unless marked optional.
 */
import semver from 'semver';
import type { Manifest, Registry } from './registry.ts';

export interface Placed {
  /** Where it goes, relative to the project: "node_modules/a" or "node_modules/a/node_modules/b". */
  path: string;
  name: string;
  version: string;
  dist: Manifest['dist'];
  bin?: Manifest['bin'];
  optionalDependencies?: Record<string, string>;
}

export interface RootPackage {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

export class UnsupportedSpecError extends Error {}

/** A dependency spec as a registry name and range ("npm:other@^1" aliases another package). */
function parseSpec(name: string, spec: string): { name: string; range: string } {
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(spec);
  if (alias) return { name: alias[1], range: alias[2] || 'latest' };
  if (/^(file|link|git|git\+[a-z]+|github|https?|workspace):|^[^@][^:]*\/[^:]*$/.test(spec)) {
    throw new UnsupportedSpecError(`${name}@${spec}: only registry versions can be installed in the browser (not files, links, git or URLs)`);
  }
  return { name, range: spec.trim() || 'latest' };
}

function pick(packument: { 'dist-tags': Record<string, string>; versions: Record<string, Manifest> }, range: string): Manifest | null {
  const tagged = packument['dist-tags'][range];
  if (tagged) return packument.versions[tagged] ?? null;
  const latest = packument['dist-tags'].latest;
  if (latest && packument.versions[latest] && semver.satisfies(latest, range, { loose: true })) return packument.versions[latest];
  const best = semver.maxSatisfying(Object.keys(packument.versions), range, { loose: true });
  return best ? packument.versions[best] : null;
}

/** The node_modules paths that `from` resolves `name` through, nearest first (as require does). */
function lookupPaths(from: string, name: string): string[] {
  const out: string[] = [];
  let dir = from;
  for (;;) {
    out.push(dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`);
    if (!dir) return out;
    const at = dir.lastIndexOf('/node_modules/');
    dir = at === -1 ? '' : dir.slice(0, at);
  }
}

export async function resolveTree(root: RootPackage, registry: Registry, options: { lockfile?: string | null; extra?: Record<string, string>; log?: (line: string) => void } = {}): Promise<Map<string, Placed>> {
  if (options.lockfile) {
    const fromLock = await fromLockfile(options.lockfile, registry);
    if (fromLock) {
      // Extra packages (the WebAssembly SWC build) go on top of the locked tree.
      for (const [name, spec] of Object.entries(options.extra ?? {})) {
        if (fromLock.has(`node_modules/${name}`)) continue;
        const sub = await resolveTree({ dependencies: { [name]: spec } }, registry);
        for (const [path, p] of sub) if (!fromLock.has(path)) fromLock.set(path, p);
      }
      return fromLock;
    }
    options.log?.('package-lock.json is not a v2/v3 lockfile: resolving the ranges instead');
  }
  const overrides = Object.fromEntries(Object.entries(root.overrides ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const placed = new Map<string, Placed>();
  let level: { from: string; name: string; spec: string; peer?: boolean }[] = Object.entries({ ...root.devDependencies, ...root.dependencies, ...options.extra }).map(([name, spec]) => ({ from: '', name, spec }));
  while (level.length) {
    level.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
    const wanted = level.map((d) => ({ ...d, ...parseSpec(d.name, overrides[d.name] ?? d.spec), as: d.name }));
    const packuments = await Promise.all(wanted.map((w) => registry.packument(w.name)));
    const next: typeof level = [];
    wanted.forEach((w, i) => {
      const packument = packuments[i];
      // Worded as npm words them, so failures classify the same (classify.ts: unresolvable-dependency).
      if (!packument) throw new Error(`npm error 404 Not Found - GET https://registry.npmjs.org/${w.name.replace('/', '%2f')} - Not found`);
      const visible = lookupPaths(w.from, w.as).map((p) => placed.get(p)).find(Boolean);
      if (visible && semver.satisfies(visible.version, w.range, { loose: true })) return;
      // A peer comes from where its dependent is installed, never from inside it: a visible copy is
      // used even if its version does not match (as npm --force or --legacy-peer-deps would), so
      // packages that share a peer share one copy (emnapi's core and the bindings built with it).
      if (w.peer && visible) return;
      const manifest = pick(packument, w.range);
      if (!manifest) throw new Error(`npm error notarget No matching version found for ${w.name}@${w.range}.`);
      const top = `node_modules/${w.as}`;
      const path = !placed.has(top) ? top : `${w.from}/node_modules/${w.as}`;
      if (w.peer && path !== top) return; // nowhere to share it from: left to its dependent's parent
      if (placed.has(path)) return; // the same dependent asked twice (dependency and peer)
      placed.set(path, { path, name: manifest.name, version: manifest.version, dist: manifest.dist, bin: manifest.bin, optionalDependencies: manifest.optionalDependencies });
      const bundled = new Set([manifest.bundleDependencies, manifest.bundledDependencies].flatMap((b) => (Array.isArray(b) ? b : b === true ? Object.keys(manifest.dependencies ?? {}) : [])));
      const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional);
      const parentDir = path.includes('/node_modules/') ? path.slice(0, path.lastIndexOf('/node_modules/')) : '';
      for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (bundled.has(name) || name in (manifest.optionalDependencies ?? {})) continue;
        next.push({ from: path, name, spec });
      }
      for (const [name, spec] of peers) if (!bundled.has(name)) next.push({ from: parentDir, name, spec, peer: true });
    });
    level = next;
  }
  return placed;
}

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  link?: boolean;
  inBundle?: boolean;
  name?: string;
  bin?: Manifest['bin'];
}

/** A v2/v3 lockfile's tree (its "packages"), or null for older lockfiles. */
async function fromLockfile(text: string, registry: Registry): Promise<Map<string, Placed> | null> {
  let lock: { lockfileVersion?: number; packages?: Record<string, LockEntry> };
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  if (!lock.packages || (lock.lockfileVersion ?? 1) < 2) return null;
  const placed = new Map<string, Placed>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.optional || entry.inBundle) continue;
    if (entry.link) throw new UnsupportedSpecError(`${path}: workspace links cannot be installed in the browser yet`);
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!entry.version) continue;
    let dist: Manifest['dist'] | undefined = entry.resolved ? { tarball: entry.resolved, integrity: entry.integrity } : undefined;
    let bin = entry.bin;
    if (!dist || !/^https:\/\/registry\.npmjs\.org\//.test(dist.tarball)) {
      const manifest = (await registry.packument(name))?.versions[entry.version];
      if (!manifest) throw new Error(`npm registry: ${name}@${entry.version} from the lockfile is not on the registry`);
      dist = manifest.dist;
      bin = manifest.bin;
    }
    placed.set(path, { path, name, version: entry.version, dist, bin });
  }
  return placed;
}
