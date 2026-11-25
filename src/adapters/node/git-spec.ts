/**
 * Git dependency specs (ADR 0073): which of npm's git shapes the host fetches, and what they name.
 * Pure (no Node.js imports): the install plan (local-packages.ts) reads specs with it in the host
 * and in the page alike; the fetch itself is git-packages.ts'.
 *
 * Fetched: repositories on GitHub, GitLab and Bitbucket, in each shape npm takes for them
 * (`user/repo`, `github:user/repo`, `git+https://github.com/user/repo.git`, `git+ssh://git@…`,
 * `git@github.com:user/repo.git`, `git://…`), always over HTTPS and as public repositories (an SSH
 * URL names the same repository, which is fetched without the user's keys); and repositories on
 * the hosts a deployment lists in SANDBURG_GIT_HOSTS, over HTTPS. Any other host is refused: the
 * host would fetch from wherever a project points it (an internal address included).
 *
 * The committish after `#` is npm's: a commit, branch or tag, `semver:<range>` (the highest tag in
 * it), and `path:<dir>` (a package in a directory of the repository), joined by `::`.
 */

/** A git dependency the host can fetch. */
export interface GitSpec {
  /** The host's kind: one whose archives are downloaded, or another host's repository, cloned. */
  host: 'github' | 'gitlab' | 'bitbucket' | 'other';
  /** The HTTPS origin of the repository (`https://github.com`). */
  origin: string;
  /** The repository's path on its host, without `.git` (`user/repo`; GitLab's subgroups `group/sub/repo`). */
  path: string;
  /** The repository's HTTPS URL, as git clones it. */
  url: string;
  /** The commit, branch or tag; null for the default branch (and with `semver`). */
  committish: string | null;
  /** `semver:<range>`: the highest tag in the range. */
  semver: string | null;
  /** `path:<dir>`: the package's directory inside the repository ('' for its root). */
  subdir: string;
}

/** Hosts whose repositories are fetched as archives, by hostname. */
const HOSTED: Record<string, GitSpec['host']> = { 'github.com': 'github', 'gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket' };
const SHORTCUT: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };
/** A segment of a repository's path: no `.` or `..`, nothing but what hosts allow in names. */
const SEGMENT = /^(?!\.\.?$)[\w.-]+$/;
/** A full commit id (SHA-1). */
export const FULL_SHA = /^[0-9a-f]{40}$/;

/** Whether a spec is one of npm's git shapes at all (fetchable or not): a refusal can name it as one. */
export function looksLikeGit(spec: string): boolean {
  const s = spec.trim();
  return /^(git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:)/.test(s) || /^[\w.-]+@[\w.-]+:/.test(s) || /^https?:\/\/[^#]*\.git(#.*)?$/.test(s) || /^[\w-][\w.-]*\/[\w.-]+(#.*)?$/.test(s);
}

/**
 * The repository and committish a git spec names, `{ unsupported }` for one of npm's git shapes
 * the host does not fetch (with why), or null for a spec that is no git spec. `extraHosts`: the
 * hostnames besides GitHub, GitLab and Bitbucket that a deployment allows (SANDBURG_GIT_HOSTS).
 */
export function parseGitSpec(spec: string, extraHosts: readonly string[] = []): GitSpec | { unsupported: string } | null {
  const s = spec.trim();
  if (!looksLikeGit(s)) return null;
  const hash = s.indexOf('#');
  const head = hash === -1 ? s : s.slice(0, hash);
  const fragment = hash === -1 ? '' : s.slice(hash + 1);

  let hostname: string;
  let path: string;
  const shortcut = /^(github|gitlab|bitbucket|gist):(.*)$/.exec(head);
  if (shortcut) {
    if (shortcut[1] === 'gist') return { unsupported: 'gists are not fetched' };
    hostname = SHORTCUT[shortcut[1]];
    path = shortcut[2];
  } else if (/^[\w-][\w.-]*\/[\w.-]+$/.test(head)) {
    // `user/repo`: GitHub's (a path starts with `.`, `/` or `~`).
    hostname = 'github.com';
    path = head;
  } else {
    // scp-like `git@host:user/repo.git`, or a URL (`git+ssh://git@host/user/repo.git`, `git://host/…`, `git+https://…`).
    const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.*)$/.exec(head);
    let url: URL | null = null;
    if (scp) {
      hostname = scp[1].toLowerCase();
      path = scp[2];
    } else {
      url = URL.parse(head.replace(/^git\+/, ''));
      if (!url || !/^(https?|ssh|git):$/.test(url.protocol)) return { unsupported: 'only git over HTTPS, SSH or git:// is fetched' };
      hostname = url.hostname.toLowerCase();
      path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (url.port && !(url.protocol === 'https:' && url.port === '443')) return { unsupported: 'a repository on another port is not fetched' };
    }
    const kind = HOSTED[hostname];
    if (!kind && !extraHosts.includes(hostname)) return { unsupported: `${hostname} is not a git host Sandburg fetches from (GitHub, GitLab, Bitbucket${extraHosts.length ? `, ${extraHosts.join(', ')}` : ''}; others through SANDBURG_GIT_HOSTS)` };
    // Another host's repository: over HTTPS only (its SSH URL may not be its HTTPS one, as it is on the three).
    if (!kind && url?.protocol !== 'https:') return { unsupported: `a repository on ${hostname} is fetched over HTTPS only (git+https://${hostname}/…)` };
    if (url && url.protocol !== 'ssh:' && (url.username || url.password)) return { unsupported: 'credentials in a repository URL are not used' };
  }

  const host = HOSTED[hostname] ?? 'other';
  path = path.replace(/\.git$/, '').replace(/\/+$/, '');
  const segments = path.split('/');
  if (!segments.every((p) => SEGMENT.test(p))) return { unsupported: 'not a repository path' };
  if ((host === 'github' || host === 'bitbucket') && segments.length !== 2) return { unsupported: 'not a repository path' };
  if (segments.length < 2) return { unsupported: 'not a repository path' };

  let committish: string | null = null;
  let semver: string | null = null;
  let subdir = '';
  for (const part of fragment.split('::').filter(Boolean)) {
    if (part.startsWith('semver:')) semver = part.slice('semver:'.length).trim() || '*';
    else if (part.startsWith('path:')) subdir = part.slice('path:'.length);
    else if (!part.includes(':')) committish = part;
    // npm ignores attributes it does not know.
  }
  if (committish !== null && !/^[\w./+-]+$/.test(committish)) return { unsupported: `"${committish}" is not a branch, tag or commit` };
  if (committish !== null && semver !== null) return { unsupported: 'a committish and a semver: range together' };
  subdir = subdir.replace(/^\/+|\/+$/g, '');
  if (subdir && !subdir.split('/').every((p) => SEGMENT.test(p))) return { unsupported: `path:${subdir} is not a directory inside the repository` };

  const origin = `https://${hostname}`;
  return { host, origin, path, url: `${origin}/${path}.git`, committish, semver, subdir };
}

/** The hosts besides GitHub, GitLab and Bitbucket that a deployment allows (SANDBURG_GIT_HOSTS, comma-separated hostnames). */
export function extraGitHosts(env: string | undefined): string[] {
  return (env ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h) && h.includes('.'));
}
