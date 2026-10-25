/**
 * The host installs an untrusted project's dependencies with npm. npm (through pacote) runs a
 * dependency's `prepare` script when it fetches it from a git remote or a local directory, even under
 * `--ignore-scripts`: that flag only governs the *project's* lifecycle scripts, not the preparation of
 * git and directory dependencies. A registry version never runs anything on the host. So the host
 * installs registry dependencies only: a plain semver range, version or dist-tag, or an `npm:` alias
 * to one. Anything that names a protocol (`git+ssh:`, `file:`, `https:`, `link:`, `workspace:`) or a
 * path (`../x`, a `user/repo` shorthand) is refused before npm runs.
 *
 * This is an allowlist of shapes, not a denylist of prefixes: a range contains only semver's own
 * characters, so a spec with a `:` or a `/` outside an alias name, or a bare `.`/`..`, is not a
 * registry spec whatever its prefix. The browser installer applies the same rule (see
 * node-runtime/npm/resolve.ts); this is its host-side twin, covering the lockfile a project may carry
 * as well as its package.json.
 */

/** Semver ranges, versions and dist-tags: npm's own range characters, letters and digits. No path or protocol. */
const RANGE = /^[\w.\-+~^><=*|\sxX]*$/;

/** An `npm:` alias to a registry package: `npm:name` or `npm:@scope/name@range`. */
const ALIAS = /^npm:((?:@[^/@\s]+\/)?[^@/\s:]+)(?:@(.*))?$/s;

/** Whether `spec` (a dependency value) resolves to a registry package, and nothing a fetcher would prepare. */
export function isRegistrySpec(spec: string): boolean {
  const s = spec.trim();
  const alias = ALIAS.exec(s);
  const range = alias ? (alias[1] === undefined ? '' : (alias[2] ?? '')) : s;
  // A lone "." or ".." is a directory install; a range never is.
  if (range === '.' || range === '..') return false;
  return RANGE.test(range);
}

/** Thrown when a project asks for a dependency the host does not install (not a registry version). */
export class UnsupportedDependencyError extends Error {
  readonly code = 'UNSUPPORTED';
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDependencyError';
  }
}

function reject(name: string, spec: string): never {
  throw new UnsupportedDependencyError(`${name}@${spec}: only registry versions can be installed (not files, links, git or URLs)`);
}

/** Validates each string leaf of an `overrides` tree (values are specs, except a nested object of more overrides). */
function checkOverrides(overrides: unknown, where: string): void {
  if (!overrides || typeof overrides !== 'object') return;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof value === 'string') {
      // An override value may be a bare version with a leading "$" (reuse the root's) — that is a range.
      if (value.startsWith('$')) continue;
      if (!isRegistrySpec(value)) reject(`${where}.${key}`, value);
    } else checkOverrides(value, `${where}.${key}`);
  }
}

/** Refuses a manifest whose dependencies, devDependencies or overrides name anything but registry versions. */
export function assertRegistryManifest(manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; overrides?: unknown }): void {
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== 'string' || !isRegistrySpec(spec)) reject(name, String(spec));
    }
  }
  checkOverrides(manifest.overrides, 'overrides');
}

/**
 * The origins a package may be fetched from: npm's configured registry, and the public registry as a
 * default. A lockfile's `resolved` tarball URLs point at the registry that produced them; anything
 * else is another host the install would reach.
 */
export function registryOrigins(): Set<string> {
  const out = new Set<string>(['https://registry.npmjs.org']);
  const reg = process.env.npm_config_registry;
  if (reg) {
    try {
      out.add(new URL(reg).origin);
    } catch {
      // not a URL: the default stands
    }
  }
  return out;
}

/** A `version`/`from` string that names a non-registry source (a protocol or a path): git, file, link, a URL. */
function nonRegistryVersion(value: string): boolean {
  return /:\/\/|^(git\+|git:|file:|link:|workspace:|github:|gitlab:|bitbucket:|gist:|https?:|npm:)/.test(value) || value.startsWith('/') || /^\.\.?[/\\]/.test(value);
}

/** A `resolved` string that points anywhere but an allowed registry origin (another host, or a non-URL such as git+…/file:). */
function resolvedOffRegistry(value: string, origins: Set<string>): boolean {
  const url = URL.parse(value);
  return !url || !origins.has(url.origin);
}

/**
 * Refuses a lockfile that installs anything but registry packages: a `link` entry, a package whose
 * `resolved` is not a tarball on an allowed registry origin, or a git/file/path `version` or `from`.
 * npm would clone, fetch or prepare such an entry during the install the store falls back to (and
 * `npm cache add` of an off-registry `resolved` fetches that host). Used for the project's own
 * lockfile and, after resolution, for the tree npm resolved (its transitive dependencies).
 */
export function assertRegistryLockfile(lockText: string, origins: Set<string> = registryOrigins()): void {
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    // Not JSON: npm will reject it without fetching anything.
    return;
  }
  if (!lock || typeof lock !== 'object') return;
  const l = lock as { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  // npm lockfile v2/v3: the `packages` map (keyed by location).
  for (const [loc, entry] of Object.entries(l.packages ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { link?: unknown; resolved?: unknown; version?: unknown } & Record<string, unknown>;
    const at = loc || '<root>';
    if (e.link === true) reject(at, 'link:');
    if (typeof e.resolved === 'string' && e.resolved !== '' && resolvedOffRegistry(e.resolved, origins)) reject(at, e.resolved);
    if (typeof e.version === 'string' && nonRegistryVersion(e.version)) reject(at, e.version);
    // The dependency ranges each package declares: a git, directory or URL spec here is a transitive
    // non-registry dependency (npm may leave it as an empty node the full install would then fetch).
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = e[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof spec === 'string' && !isRegistrySpec(spec)) reject(`${at} → ${dep}`, spec);
      }
    }
  }
  // npm lockfile v1 (and the v2 back-compat tree): nested `dependencies`.
  const walk = (deps: Record<string, unknown> | undefined, path: string): void => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { resolved?: unknown; version?: unknown; from?: unknown; dependencies?: Record<string, unknown> };
      const at = path ? `${path}/${name}` : name;
      if (typeof e.resolved === 'string' && e.resolved !== '' && resolvedOffRegistry(e.resolved, origins)) reject(at, e.resolved);
      for (const value of [e.version, e.from]) {
        if (typeof value === 'string' && value !== '' && nonRegistryVersion(value)) reject(at, value);
      }
      walk(e.dependencies, at);
    }
  };
  walk(l.dependencies, '');
}
