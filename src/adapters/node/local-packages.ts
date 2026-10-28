/**
 * Local packages (ADR 0063): a monorepo's workspaces (npm's and yarn's `workspaces`,
 * pnpm-workspace.yaml) and `file:`, `link:` and `workspace:` dependencies on directories inside the
 * project. npm never sees them: the host installs registry packages only, because npm prepares a
 * directory or git dependency on the host whatever `--ignore-scripts` says (spec-guard.ts, ADR 0054).
 *
 * So the plan takes them out of what npm installs. Their registry dependencies are installed at
 * the project's root with the root's own, as npm hoists a workspace's (one a local package needs in
 * another version than the root goes into that package's own node_modules), and each local package
 * is linked where npm would link it, `node_modules/<name>`: the runtime puts the package's files
 * there and resolves them to the package's own directory, as Node resolves a symlink (worker.ts,
 * links.ts). Anything that points outside the project is refused, as unsupported, before anything
 * is installed.
 *
 * Pure (no Node.js imports): the host's install and the page's use the same plan.
 */
import semver from 'semver';
import { parseRegistrySpec, unsupportedDependency } from './spec-guard.ts';
import { lockPins } from './lockfile-pins.ts';
import { workspaceDirs } from '../../workspaces.ts';
import type { FileTree, PackageJson } from '../../types.ts';

/** What npm installs in one place. */
interface InstallManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: unknown;
}

export interface InstallPlan {
  /** What npm installs at the project's root: its registry dependencies, and those of every local package. */
  root: InstallManifest;
  /** The root's package-lock.json, without the entries of its local packages (their links and directories), or null. */
  lockfile: string | null;
  /** Registry dependencies a local package needs in another version than the root's: installed into its own node_modules. */
  nested: { dir: string; dependencies: Record<string, string> }[];
  /** Where each local package appears (a project-relative node_modules path) → its directory. */
  links: Record<string, string>;
  /** Workspace packages by name → directory (for `npm -w <name>`, `pnpm --filter <name>`, `yarn workspace <name>`). */
  workspaces: Record<string, string>;
  /** The lockfile other than package-lock.json whose versions the plan pins (lockfile-pins.ts), or null. */
  pinned: 'pnpm-lock.yaml' | 'yarn.lock' | null;
  /** The directories of local packages: their dependencies are installed here, not as projects of their own. */
  local: string[];
}

/** A local package the project names but that is not there: the app's mistake, as npm would report it. */
class LocalPackageError extends Error {
  readonly code = 'APP';
  constructor(message: string) {
    super(message);
    this.name = 'LocalPackageError';
  }
}

/** A path inside the project, from `dir` (project-relative) and a relative path; null if it leaves the project. */
function inside(dir: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(rel) || rel.includes('\\')) return null;
  const parts = dir ? dir.split('/') : [];
  for (const p of rel.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join('/');
}

const LOCAL_TARBALL = /\.(tgz|tar|tar\.gz)$/i;

/** The install plan of a project (its files and root package.json). */
export function installPlan(files: FileTree, pkg: PackageJson | null): InstallPlan {
  const read = (dir: string): PackageJson | null => {
    const text = files[dir ? `${dir}/package.json` : 'package.json'];
    if (typeof text !== 'string') return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PackageJson) : null;
    } catch {
      return null;
    }
  };
  const root = pkg ?? {};
  const members = workspaceDirs(files, pkg);
  const workspaces: Record<string, string> = {};
  const manifests = new Map<string, PackageJson>();
  for (const dir of members) {
    const manifest = read(dir);
    if (!manifest) throw new LocalPackageError(`npm error code EJSONPARSE: ${dir}/package.json is not a valid package.json`);
    manifests.set(dir, manifest);
    if (typeof manifest.name !== 'string') continue;
    const other = workspaces[manifest.name];
    if (other !== undefined) throw new LocalPackageError(`npm error must not have multiple workspaces with the same name: package '${manifest.name}' in ${other} and ${dir}`);
    workspaces[manifest.name] = dir;
  }
  const pins = lockPins(files);
  let pinnedAny = false;
  const pin = (dir: string, name: string, spec: string): string => {
    const version = pins?.direct(dir, name, spec);
    if (!version) return spec;
    pinnedAny = true;
    return version;
  };

  /** The directory a dependency of the package at `dir` links to, or null for a registry dependency. */
  const target = (dir: string, name: string, spec: string): string | null => {
    const s = spec.trim();
    const at = dir || '.';
    if (s.startsWith('workspace:')) {
      const rest = s.slice('workspace:'.length);
      // `workspace:*`, `workspace:^1.0.0`, `workspace:other@*` (an alias), `workspace:packages/x` (yarn: a path).
      const alias = /^((?:@[^/@]+\/)?[^/@]+)@(.*)$/.exec(rest);
      const wanted = alias ? alias[1] : name;
      if (!alias && (rest.startsWith('.') || rest.includes('/'))) {
        const path = inside(dir, rest);
        if (path === null) throw unsupportedDependency(name, spec, 'it points outside the project; only packages inside the project are linked');
        if (!members.includes(path)) throw new LocalPackageError(`${at}: ${name}@${spec}: ${path} is not one of the project's workspaces`);
        return path;
      }
      const found = workspaces[wanted];
      if (found === undefined) throw new LocalPackageError(`${at}: ${name}@${spec}: no workspace package is named "${wanted}" (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND)`);
      return found;
    }
    const path = /^(file|link):/.test(s) ? s.slice(s.indexOf(':') + 1) : /^(\.{1,2}(\/|$)|\/|~\/)/.test(s) ? s : null;
    if (path !== null) {
      if (LOCAL_TARBALL.test(path)) throw unsupportedDependency(name, spec, 'local tarballs are not installed; only npm registry versions and package directories inside the project are');
      const local = inside(dir, path);
      if (local === null) throw unsupportedDependency(name, spec, 'it points outside the project; only packages inside the project are linked');
      if (local === dir) throw unsupportedDependency(name, spec, 'a package cannot depend on its own directory');
      if (!read(local)) throw new LocalPackageError(`${at}: ${name}@${spec}: no package.json at ${local || '.'}`);
      return local;
    }
    // npm links a workspace for a plain range its version satisfies.
    const ws = workspaces[name];
    const version = ws !== undefined ? manifests.get(ws)?.version : undefined;
    if (ws !== undefined && (s === '*' || s === '' || (typeof version === 'string' && semver.validRange(s) && semver.satisfies(version, s, { includePrerelease: true })))) return ws;
    if (parseRegistrySpec(name, s)) return null;
    throw unsupportedDependency(name, spec);
  };

  // The root, every workspace, and each package a file:/link: dependency reaches: their dependencies
  // in that order (a workspace's and the root's devDependencies too, as npm installs them).
  const wants: { dir: string; name: string; spec: string; field: 'dependencies' | 'devDependencies' }[] = [];
  const declared: { dir: string; name: string; to: string }[] = [];
  const queue: { dir: string; manifest: PackageJson; dev: boolean }[] = [{ dir: '', manifest: root, dev: true }, ...members.map((dir) => ({ dir, manifest: manifests.get(dir)!, dev: true }))];
  const seen = new Set(queue.map((q) => q.dir));
  for (let i = 0; i < queue.length; i++) {
    const { dir, manifest, dev } = queue[i];
    for (const field of dev ? (['dependencies', 'devDependencies'] as const) : (['dependencies'] as const)) {
      const deps = manifest[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, raw] of Object.entries(deps)) {
        const spec = String(raw);
        const to = target(dir, name, spec);
        if (to === null) {
          wants.push({ dir, name, spec: pin(dir, name, spec), field });
          continue;
        }
        declared.push({ dir, name, to });
        if (!seen.has(to)) {
          seen.add(to);
          queue.push({ dir: to, manifest: read(to)!, dev: false });
        }
      }
    }
  }
  const local = [...seen].filter((d) => d !== '').sort();

  // Without local packages or pins, what npm installs is the project's own package.json (and the
  // install's key, a digest of it, is the one it was).
  const lockText = files['package-lock.json'];
  const lock = typeof lockText === 'string' ? lockText : null;
  if (!local.length && !pins) {
    return { root: { dependencies: root.dependencies, devDependencies: root.devDependencies, overrides: root.overrides }, lockfile: lock, nested: [], links: {}, workspaces, pinned: null, local };
  }

  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const nested = new Map<string, Record<string, string>>();
  const hoisted = (name: string) => dependencies[name] ?? devDependencies[name];
  for (const w of wants) {
    if (!w.dir) (w.field === 'dependencies' ? dependencies : devDependencies)[w.name] = w.spec;
  }
  for (const w of wants) {
    if (!w.dir) continue;
    const there = hoisted(w.name);
    // A local package's dependencies are installed with the root's, or into its own node_modules
    // when it needs another version.
    if (there === undefined) dependencies[w.name] = w.spec;
    else if (there !== w.spec) nested.set(w.dir, { ...nested.get(w.dir), [w.name]: w.spec });
  }

  // npm links every workspace at the top of node_modules, and a file:/link: dependency there unless
  // that place is taken (then into its dependent's node_modules). A registry package of the same
  // name keeps the top.
  const links: Record<string, string> = {};
  for (const [name, dir] of Object.entries(workspaces)) if (hoisted(name) === undefined) links[`node_modules/${name}`] = dir;
  for (const { dir, name, to } of declared) {
    const top = `node_modules/${name}`;
    if (links[top] === to) continue;
    if (links[top] === undefined && hoisted(name) === undefined) links[top] = to;
    else links[dir ? `${dir}/node_modules/${name}` : top] = to;
  }

  // The lockfile's single-version packages, pinned with overrides; never one the project names itself
  // (npm refuses an override that differs from a direct dependency's spec), nor one it overrides.
  const named = new Set([...wants.map((w) => w.name), ...declared.map((d) => d.name), ...Object.keys(workspaces)]);
  const own = root.overrides && typeof root.overrides === 'object' ? (root.overrides as Record<string, unknown>) : null;
  let overrides: unknown = root.overrides;
  if (pins) {
    const singles = Object.entries(pins.single).filter(([name]) => !named.has(name) && !(own && name in own));
    if (singles.length) {
      overrides = { ...Object.fromEntries(singles), ...own };
      pinnedAny = true;
    }
  }

  return {
    root: { dependencies, devDependencies, overrides },
    lockfile: lock !== null && local.length ? withoutLocal(lock, local, { dependencies, devDependencies }) : lock,
    nested: [...nested].sort(([a], [b]) => a.localeCompare(b)).map(([dir, deps]) => ({ dir, dependencies: deps })),
    links,
    workspaces,
    pinned: pinnedAny ? pins!.source : null,
    local,
  };
}

/**
 * A package-lock.json without its local packages: their link entries (`node_modules/web` →
 * `apps/web`), their directories' entries (`apps/web`, `apps/web/node_modules/…`) and the v2
 * lockfile's back-compat tree (which records them as `file:` versions). The root's entry is the
 * plan's. What is left are registry packages, checked as any lockfile is (assertRegistryLockfile);
 * npm reconciles the tree with the plan's package.json.
 */
function withoutLocal(text: string, local: string[], root: InstallManifest): string {
  let lock: { lockfileVersion?: number; packages?: Record<string, unknown>; dependencies?: unknown; [k: string]: unknown };
  try {
    lock = JSON.parse(text);
  } catch {
    return text;
  }
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') return text;
  const dirs = new Set(local);
  const isLocal = (loc: string) => local.some((d) => loc === d || loc.startsWith(`${d}/`));
  const packages: Record<string, unknown> = {};
  for (const [loc, entry] of Object.entries(lock.packages)) {
    if (loc === '') continue;
    if (isLocal(loc)) continue;
    const e = entry as { link?: unknown; resolved?: unknown } | null;
    if (e && e.link === true && typeof e.resolved === 'string' && dirs.has(inside('', e.resolved) ?? '')) continue;
    packages[loc] = entry;
  }
  const rest: Record<string, unknown> = { ...lock };
  delete rest.dependencies;
  return JSON.stringify({ ...rest, lockfileVersion: Math.max(3, lock.lockfileVersion ?? 3), packages: { '': { dependencies: root.dependencies, devDependencies: root.devDependencies }, ...packages } }, null, 2);
}
