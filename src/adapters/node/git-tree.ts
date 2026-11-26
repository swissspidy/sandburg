/**
 * Where a git dependency's files go in a project's file tree (ADR 0073), and filling it from a
 * fetcher a page supplies: the host's own fetch is git-packages.ts'; a page that embeds the browser
 * runtime (`sandburg/browser-runtime`) cannot fetch a repository itself (the git hosts' archive and
 * git endpoints send no CORS headers), so its embedder gives startProject a function that does
 * (EmbedOptions.git), through a server of its own for instance.
 *
 * The layout, the same in both: each git dependency's files in `.sandburg/git/<repository>-<commit>/`
 * (its subdirectory for a `path:` spec), and `.sandburg/git.json`, the map from each spec, as the
 * package.json names it, to that directory. The install plan (local-packages.ts) links a mapped
 * directory as a local package. A host that is neither may write it itself, before mount().
 *
 * Pure (no Node.js imports).
 */
import { FULL_SHA, parseGitSpec, type GitSpec } from './git-spec.ts';
import { GIT_DIR, GIT_FILE, gitDirs, installPlan } from './local-packages.ts';
import { unsupportedDependency } from './spec-guard.ts';
import type { FileTree, PackageJson } from '../../types.ts';

export { GIT_DIR, GIT_FILE };

/** A git dependency to fetch, as the project names it and as Sandburg reads it. */
export interface GitDependencyRequest {
  /** The dependency's name (its key in package.json). */
  name: string;
  /** The spec as package.json has it (`github:user/repo#v1`). */
  spec: string;
  /** The repository's host: GitHub, GitLab or Bitbucket. */
  host: GitSpec['host'];
  /** The repository's HTTPS URL, as git clones it (`https://github.com/user/repo.git`). */
  url: string;
  /** The repository's path on its host (`user/repo`). */
  path: string;
  /** The commit, branch or tag after `#`; null for the default branch (and with `semver`). */
  committish: string | null;
  /** `#semver:<range>`: the highest tag in the range. */
  semver: string | null;
  /** `path:<dir>`: the package's directory in the repository ('' for its root). Return the whole repository; Sandburg takes this directory. */
  subdir: string;
}

/** What a fetcher returns: the commit the spec resolved to (its full id), and the repository's files at it, by path from its root. */
export interface FetchedGitDependency {
  commit: string;
  files: FileTree;
}

/** Fetches one git dependency: resolves its branch, tag or range to a commit and returns that commit's files. */
export type GitFetcher = (dependency: GitDependencyRequest) => Promise<FetchedGitDependency>;

/** The directory a commit's files go to: `.sandburg/git/<host>-<repository>-<commit>` (and its `path:` subdirectory). */
export function gitDir(spec: GitSpec, commit: string): string {
  return `${GIT_DIR}/${`${spec.origin.slice('https://'.length)}-${spec.path}`.replace(/[^\w.-]+/g, '-')}-${commit.slice(0, 12)}${spec.subdir ? `/${spec.subdir}` : ''}`;
}

/** What a page's fetcher may add, at most (the host's own limits are git-packages.ts' gitLimits). */
const pageGitLimits = { packages: 50, files: 50_000 };

/** Whether a path from a fetcher is a plain relative one (no `..`, no empty segment, not absolute). */
const plainPath = (path: string) => !path.startsWith('/') && !path.split('/').some((s) => s === '' || s === '.' || s === '..');

/**
 * The project's files with its git dependencies' files, fetched by `fetchGit`, in the layout above:
 * each git dependency the root, a workspace, a local package or a fetched git package names (those
 * are fetched in turn, as the host does). The files as they were when it names none.
 */
export async function withGitDependencies(files: FileTree, packageJson: PackageJson | null, fetchGit: GitFetcher, options: { log?: (line: string) => void } = {}): Promise<FileTree> {
  // What the project's files already have (fetched before): kept, and not fetched again.
  const map: Record<string, string> = gitDirs(files);
  let count = 0;
  let total = 0;
  for (;;) {
    // One fetch per spec, however many packages name it.
    const pending = new Map<string, string>();
    for (const g of installPlan(files, packageJson).git) if (!pending.has(g.spec)) pending.set(g.spec, g.name);
    if (!pending.size) break;
    const added: FileTree = {};
    await Promise.all(
      [...pending].map(async ([raw, name]) => {
        const spec = parseGitSpec(raw);
        if (!spec || !('url' in spec)) throw unsupportedDependency(name, raw, spec?.unsupported ?? 'not a git repository');
        if (++count > pageGitLimits.packages) throw unsupportedDependency(name, raw, `more than ${pageGitLimits.packages} git dependencies`);
        const label = `${name}@${raw}`;
        const { commit, files: tree } = await fetchGit({ name, spec: raw, host: spec.host, url: spec.url, path: spec.path, committish: spec.committish, semver: spec.semver, subdir: spec.subdir });
        if (typeof commit !== 'string' || !FULL_SHA.test(commit)) throw new Error(`git: ${label}: the fetcher returned no full commit id (40 hexadecimal characters)`);
        const at = gitDir(spec, commit);
        const prefix = spec.subdir ? `${spec.subdir}/` : '';
        let n = 0;
        for (const [path, data] of Object.entries(tree ?? {})) {
          if (!plainPath(path)) throw new Error(`git: ${label}: the fetcher returned a path outside the repository (${path})`);
          if (!path.startsWith(prefix) || path.split('/').some((s) => s === '.git' || s === 'node_modules')) continue;
          added[`${at}/${path.slice(prefix.length)}`] = data;
          n++;
        }
        total += n;
        if (total > pageGitLimits.files) throw unsupportedDependency(name, raw, `the project's git dependencies have more than ${pageGitLimits.files} files together`);
        if (typeof tree?.[`${prefix}package.json`] !== 'string') throw Object.assign(new Error(`git: ${label}: no package.json at ${spec.subdir || 'the repository root'} (commit ${commit.slice(0, 12)})`), { code: 'APP' });
        map[raw.trim()] = at;
        options.log?.(`git: ${label} → ${commit.slice(0, 12)} (${n} files)`);
      }),
    );
    files = { ...files, ...added, [GIT_FILE]: JSON.stringify(map) };
  }
  return files;
}
