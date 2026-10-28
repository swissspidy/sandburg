/**
 * The versions a pnpm-lock.yaml or yarn.lock pins, for a project without a package-lock.json
 * (ADR 0064). npm cannot read them, and their trees are not npm's (pnpm's is isolated, yarn's
 * descriptors are not locations), so they are not translated into a package-lock. Instead:
 *
 * - each package's direct dependencies are pinned to the version the lockfile resolved for that
 *   package and range (pnpm: its importer; yarn: the `name@range` descriptor), when that version
 *   still satisfies the range in package.json (a lockfile older than package.json is not used for it);
 * - every other package the lockfile has in exactly one version is pinned to it, with an
 *   `overrides` entry. With the direct dependencies at their locked versions, their ranges are the
 *   ones the lockfile was resolved against, which that one version satisfied. A package the
 *   lockfile has in several versions is left to its ranges.
 *
 * Pure (no Node.js imports): the host's install and the page's use the same pins.
 */
import semver from 'semver';
import { parseYaml, type YamlValue } from '../../yaml-lite.ts';
import type { FileTree } from '../../types.ts';
import { isPackageName } from './spec-guard.ts';

export interface LockPins {
  /** The lockfile the pins come from. */
  source: 'pnpm-lock.yaml' | 'yarn.lock';
  /** The locked version of a package's direct dependency (package at `dir`, '' the root), or null. */
  direct(dir: string, name: string, spec: string): string | null;
  /** Packages the lockfile has in one version only: name → version. */
  single: Record<string, string>;
}

/** The pins of the project's pnpm-lock.yaml or yarn.lock, or null (none, a package-lock.json, or a lockfile this cannot read). */
export function lockPins(files: FileTree): LockPins | null {
  if (typeof files['package-lock.json'] === 'string' || typeof files['npm-shrinkwrap.json'] === 'string') return null;
  const pnpm = files['pnpm-lock.yaml'];
  if (typeof pnpm === 'string') return pnpmPins(pnpm);
  const yarn = files['yarn.lock'];
  if (typeof yarn === 'string') return yarnPins(yarn);
  return null;
}

const asMap = (v: YamlValue | undefined): Record<string, YamlValue> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** A locked version without pnpm's peer suffix ("18.3.1(react@18.3.1)", v5's "18.3.1_react@18.3.1"), if it is a version. */
function lockedVersion(value: string): string | null {
  const v = value.replace(/\(.*$/, '').replace(/_.*$/, '');
  return semver.valid(v);
}

/** A version that satisfies `spec`, or null (a dist-tag, an alias or another protocol is not pinned). */
function satisfying(version: string | null, spec: string): string | null {
  if (!version || !semver.validRange(spec, { loose: true })) return null;
  return semver.satisfies(version, spec, { loose: true }) ? version : null;
}

/** Name and version of a pnpm `packages` key: "name@1.0.0" (v9), "/name@1.0.0(peer)" (v6), "/name/1.0.0_peer" (v5). */
function pnpmPackageKey(key: string): { name: string; version: string } | null {
  const k = key.startsWith('/') ? key.slice(1) : key;
  for (const i of [k.indexOf('@', 1), k.lastIndexOf('/')].filter((i) => i > 0)) {
    const name = k.slice(0, i);
    const version = isPackageName(name) ? lockedVersion(k.slice(i + 1)) : null;
    if (version) return { name, version };
  }
  return null;
}

function pnpmPins(text: string): LockPins | null {
  const doc = asMap(parseYaml(text));
  if (!('lockfileVersion' in doc)) return null;
  // Importers (workspaces); a lockfile without them (pnpm 5, one package) has its root's at the top.
  const importers = asMap(doc.importers);
  const importer = (dir: string) => asMap(importers[dir || '.'] ?? (dir ? undefined : doc));
  const direct = (dir: string, name: string, spec: string): string | null => {
    const imp = importer(dir);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const entry = asMap(imp[field])[name] ?? undefined;
      if (entry === undefined) continue;
      // v6/v9: { specifier, version }; v5: the version, with the specifier in `specifiers`.
      const version = typeof entry === 'string' ? entry : asMap(entry).version;
      if (typeof version === 'string') return satisfying(lockedVersion(version), spec);
    }
    return null;
  };
  const versions = new Map<string, Set<string>>();
  for (const key of Object.keys(asMap(doc.packages))) {
    const p = pnpmPackageKey(key);
    if (p) versions.set(p.name, (versions.get(p.name) ?? new Set()).add(p.version));
  }
  return { source: 'pnpm-lock.yaml', direct, single: singles(versions) };
}

/**
 * A yarn.lock (classic v1, or berry's YAML): its entries by descriptor ("name@range", berry's npm:
 * dropped), each with the package it resolves to and the version. An alias's descriptor
 * (`"string-width-cjs@npm:string-width@^4.2.0"`) resolves to its real package: it is pinned by
 * that name, never by the alias.
 */
function yarnEntries(text: string): Map<string, { name: string; version: string }> {
  const out = new Map<string, { name: string; version: string }>();
  let descriptors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      // `"a@^1", a@~1.2:` (classic) or `"a@npm:^1, a@npm:~1.2":` (berry).
      descriptors = line
        .replace(/:\s*$/, '')
        .split(/,\s*/)
        .map((d) => d.trim().replace(/^"|"$/g, ''));
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (!m || !descriptors.length) continue;
    for (const d of descriptors) {
      const at = d.indexOf('@', 1);
      if (at < 0) continue;
      const name = d.slice(0, at);
      let range = d.slice(at + 1);
      // Berry's protocols other than npm: (workspace:, patch:, link:, portal:, file:) are not registry versions.
      if (/^[a-z]+:/.test(range) && !range.startsWith('npm:')) continue;
      const aliased = range.startsWith('npm:') ? ALIASED.exec(range.slice('npm:'.length)) : null;
      range = range.replace(/^npm:/, '');
      const real = aliased ? aliased[1] : name;
      if (!isPackageName(name) || !isPackageName(real)) continue;
      out.set(`${name}@${range}`, { name: real, version: m[1] });
    }
    descriptors = [];
  }
  return out;
}
/** An alias's target after `npm:`: `<package>@<range>`. */
const ALIASED = /^((?:@[^/@\s]+\/)?[^/@\s]+)@(.*)$/;

function yarnPins(text: string): LockPins | null {
  const entries = yarnEntries(text);
  if (!entries.size) return null;
  const versions = new Map<string, Set<string>>();
  for (const { name, version } of entries.values()) {
    const v = semver.valid(version);
    if (v) versions.set(name, (versions.get(name) ?? new Set()).add(v));
  }
  // yarn locks by descriptor, not by package: the same range resolves the same in every workspace.
  // An alias is not pinned: its spec (`npm:other@^1`) is not a range.
  const direct = (_dir: string, name: string, spec: string) => satisfying(semver.valid(entries.get(`${name}@${spec}`)?.version ?? ''), spec);
  return { source: 'yarn.lock', direct, single: singles(versions) };
}

function singles(versions: Map<string, Set<string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, set] of [...versions].sort(([a], [b]) => a.localeCompare(b))) if (set.size === 1) out[name] = [...set][0];
  return out;
}
