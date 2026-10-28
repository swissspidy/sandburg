/**
 * A monorepo's workspaces, from its files alone: the package directories that a root package.json's
 * `workspaces` (npm, yarn) or a pnpm-workspace.yaml `packages` list names (ADR 0063). No Node.js
 * imports: project loading, the host's install plan and the page's use it.
 */
import { parseYaml } from './yaml-lite.ts';
import type { FileTree, PackageJson } from './types.ts';

/**
 * The workspace globs of a project's root (npm's and yarn's `workspaces`, as a list or as
 * `{ packages }`, and pnpm-workspace.yaml's `packages`), or null when the root declares none.
 */
export function workspacePatterns(files: FileTree, pkg: PackageJson | null): string[] | null {
  const out: string[] = [];
  let declared = false;
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : ws && typeof ws === 'object' ? (ws as { packages?: unknown }).packages : undefined;
  if (Array.isArray(list)) {
    declared = true;
    out.push(...list.filter((p): p is string => typeof p === 'string'));
  }
  const yaml = files['pnpm-workspace.yaml'] ?? files['pnpm-workspace.yml'];
  if (typeof yaml === 'string') {
    declared = true;
    const doc = parseYaml(yaml);
    const packages = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.packages : undefined;
    if (Array.isArray(packages)) out.push(...packages.filter((p): p is string => typeof p === 'string'));
  }
  return declared ? out : null;
}

/** A workspace glob as a regular expression over directory paths: `*` one segment, `**` any number. */
function globToRegExp(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '*' && clean[i + 1] === '*') {
      // `**/` (or a trailing `**`): any number of directories, none included.
      if (clean[i + 2] === '/') {
        re += '(?:[^/]+/)*';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Whether `dir` (project-relative, no trailing slash) is one of the workspaces `patterns` name. */
export function isWorkspace(dir: string, patterns: string[]): boolean {
  if (!dir || dir.split('/').some((s) => s === 'node_modules' || s === '..' || s === '.')) return false;
  let member = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(dir)) member = false;
    } else if (globToRegExp(p).test(dir)) member = true;
  }
  return member;
}

/** The workspace directories of a project (those with a package.json), sorted; [] for a project without workspaces. */
export function workspaceDirs(files: FileTree, pkg: PackageJson | null): string[] {
  const patterns = workspacePatterns(files, pkg);
  if (!patterns) return [];
  return Object.keys(files)
    .map((p) => /^(.+)\/package\.json$/.exec(p)?.[1])
    .filter((d): d is string => !!d && isWorkspace(d, patterns))
    .sort();
}
