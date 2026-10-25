/**
 * Packages npm installed more than once at one version, bundled once (bundle.ts). npm nests a copy
 * of a package wherever the one above does not satisfy the range: crypto-browserify's dependencies
 * have bn.js 4.12.5 six times (the top-level one is 5.2.5) and readable-stream 2.3.8 twice, and
 * esbuild bundled each copy, ~0.5 MB of node:crypto's 1.24 MB script.
 *
 * A file of a nested copy resolves to the same file of the copy whose directory sorts first, when
 * the two are the same package: same name and version, the file's bytes the same, and the
 * dependencies that both resolve (by Node's walk up the node_modules directories) the same packages,
 * all the way down (samePackage). Then the code that runs is the same, and so is what it requires.
 * This runs on the host, at build time, over Sandburg's own dependencies: not over an app's.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const NM = `${sep}node_modules${sep}`;

/** node_modules directory → package name → the directories of its copies there and below, sorted. */
const copiesIn = new Map<string, Map<string, string[]>>();

function copies(nodeModules: string): Map<string, string[]> {
  let found = copiesIn.get(nodeModules);
  if (found) return found;
  found = new Map();
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // no node_modules here
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const scoped = name.startsWith('@') ? readdirSync(join(dir, name)).map((n) => `${name}/${n}`) : [name];
      for (const pkg of scoped) {
        const root = join(dir, pkg);
        if (!found.has(pkg)) found.set(pkg, []);
        found.get(pkg)!.push(root);
        if (depth < 4) visit(join(root, 'node_modules'), depth + 1);
      }
    }
  };
  visit(nodeModules, 0);
  for (const roots of found.values()) roots.sort();
  copiesIn.set(nodeModules, found);
  return found;
}

const manifests = new Map<string, { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } | null>();
function manifest(root: string) {
  if (!manifests.has(root)) {
    try {
      manifests.set(root, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as never);
    } catch {
      manifests.set(root, null);
    }
  }
  return manifests.get(root)!;
}

/** The directory of the package `name` that `require` resolves from a package at `root`, by Node's walk up, or null. */
function resolvedDir(root: string, name: string): string | null {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Whether the packages at `a` and `b` are the same, with all they require: the same version, and each
 * dependency resolving, from both, to one directory or to packages that are the same in turn (the
 * whole resolved closure). A pair already being compared counts as the same (a cycle of
 * dependencies), so the walk ends; any difference below it still makes the outer pair differ.
 */
function samePackage(a: string, b: string, comparing = new Set<string>()): boolean {
  if (a === b) return true;
  const pair = `${a}\0${b}`;
  if (comparing.has(pair)) return true;
  const ma = manifest(a);
  const mb = manifest(b);
  if (!ma?.version || ma.version !== mb?.version) return false;
  const deps = new Set(Object.keys({ ...ma.dependencies, ...ma.optionalDependencies, ...ma.peerDependencies, ...mb.dependencies, ...mb.optionalDependencies, ...mb.peerDependencies }));
  comparing.add(pair);
  for (const d of deps) {
    const da = resolvedDir(a, d);
    const db = resolvedDir(b, d);
    if (da === null || db === null ? da !== db : !samePackage(da, db, comparing)) return false;
  }
  return true;
}

function sameBytes(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.isFile() && sb.isFile() && sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** The file to bundle for `path`: the same file of the first copy of its package, or `path` itself. */
export function dedupedPath(path: string): string {
  const first = path.indexOf(NM);
  const last = path.lastIndexOf(NM);
  if (first < 0 || first === last) return path; // not in a nested node_modules
  const after = path.slice(last + NM.length).split(sep);
  const name = after[0].startsWith('@') ? `${after[0]}/${after[1]}` : after[0];
  const root = path.slice(0, last + NM.length) + name.split('/').join(sep);
  const within = path.slice(root.length);
  for (const other of copies(path.slice(0, first + NM.length - 1)).get(name) ?? []) {
    if (other === root) return path;
    if (samePackage(other, root) && sameBytes(other + within, path)) return other + within;
  }
  return path;
}
