# ADR 0073: Git dependencies, fetched by the host and linked

- Status: Accepted
- Date: 2026-11-25

## Context

Since ADR 0054 the host installs registry dependencies only, because npm (through pacote) clones a
git dependency and *prepares* it on the host (installs its dependencies, runs its `prepare` script)
whatever `--ignore-scripts` says. ADR 0064 linked local packages instead of giving them to npm, and
left git and URL dependencies refused as `runtime-unsupported` in the probe: "fetching a git archive
from a host's API would mean another fetcher with its own integrity story". Generated apps and real
projects do name git dependencies (`user/repo`, `github:user/repo#branch`, a fork pinned by commit),
and every one of those runs failed before it started.

## Decision

### The host fetches a git dependency's files; the plan links them as a local package

A git dependency never reaches npm. Before the run is mounted, the node adapter's new `sources`
hook (`AdapterDescriptor.sources`, `src/adapters/node/git-packages.ts`) fetches each git dependency's
files into `.sandburg/git/<host>-<repository>-<commit>/` of the project's file tree, and writes
`.sandburg/git.json`, the map from each spec to its directory. The install plan
(`local-packages.ts`) then treats the directory as it treats a `file:` package (ADR 0064): linked at
`node_modules/<name>`, its `dependencies` installed with the root's (its devDependencies are not, as
npm installs a git dependency's), a range the root's copy cannot serve in its own node_modules, and
git dependencies it names fetched in turn. Both installs, the host's npm and the page's, get the same
plan; nothing in the runtime changed.

Nothing of the repository runs: its files are read, not executed, and its `prepare` script is not
run. A package whose entry point is built by `prepare` (`main: dist/index.js`, not committed) is
installed without it; the run's log says so (`its main (dist/index.js) is not in the repository, and
its prepare script is not run`), and the app fails where it imports it, as it would with a package
published without its build.

`.sandburg/` is never a project's own (`projectFromFiles` leaves it out, and the disk and zip
loaders skip it), so only the host writes there, and the plan takes a map entry only for a directory
inside `.sandburg/git/`. The run's result, its snapshot and the source checks see the project's own
files; the fetched ones are mounted and installed only.

### Fast: one listing to resolve, one archive per commit, both kept

| Step | Cost, cold | Warm |
|---|---|---|
| Resolve the committish | One ls-refs listing (isomorphic-git, git protocol v2, filtered by the server to `refs/heads/<x>` and `refs/tags/<x>`), ~200 ms; none for a full commit id or the commit the project's package-lock.json records | Within 5 minutes in the same process: none |
| Fetch the commit's files | GitHub: one `codeload.github.com` archive (~150 ms for a small package); GitLab, Bitbucket: their archive endpoints | Kept on disk by commit (`SANDBURG_GIT_DIR`, default `.sandburg/git`), and in memory: none |

Three GitHub packages, fetched in parallel, take ~430 ms cold and ~1 ms warm; the fetch starts while
the run's tab loads, so a run with git dependencies took about as long as one without in the e2e
runs (0.5 s). `semver:<range>` lists the tags (`refs/tags/`) and takes the highest in the range.

A repository on another host (allowed below) has no archive endpoint Sandburg knows: isomorphic-git
fetches the one commit shallowly (depth 1) into a temporary directory and reads its tree; a commit
given by its id that the host will not serve directly is fetched by the branch or tag at it, else
with the default branch's history.

### Which specs, and from where

Fetched (`git-spec.ts`): repositories on GitHub, GitLab (with subgroups) and Bitbucket, in each of
npm's shapes for them (`user/repo`, `github:`, `gitlab:`, `bitbucket:`, `git+https:`, `git+ssh:`,
`git@host:user/repo`, `git://`), with npm's committish (`#<commit|branch|tag>`, `#semver:<range>`,
`#…::path:<dir>`). An SSH URL names the same repository, fetched over HTTPS without credentials:
public repositories only (a private one answers 401, reported as not found, "only public repositories
are fetched").

Other hosts are refused, in the probe, unless a deployment lists them in `SANDBURG_GIT_HOSTS`
(comma-separated hostnames; then over HTTPS only, the default port). The host must not become a
project's way into an internal address: every request goes to the repository's own origin (and
`codeload.github.com` for GitHub's), a redirect is followed only within those, and credentials in a
URL are refused.

Still refused: gists, local tarballs, URL tarball dependencies, git dependencies of a `client/` or
`server/` package installed on its own (packageDirs; the probe says which), and a git dependency of a
*registry* package (npm resolves it; the registry-only check on the resolved tree refuses it as
before, ADR 0054).

### Integrity

A commit id names the repository's content, but an archive is not checked against it: the host
trusts the repository's host over TLS for the archive of a commit, as npm trusts the registry for a
tarball without an integrity, and keeps it by commit. A clone (other hosts) is checked by git's object
ids. Limits: 20 000 files and 256 MB unpacked per repository (an archive, or a git protocol
response, larger than that is refused before or as it is read), 50 000 files and 512 MB unpacked,
and 512 MB received, for a project's git packages together, counted as the parallel fetches go, 50 distinct git
specs per project (a spec several workspaces name is fetched once, the root's lockfile commit for
all); the repositories kept in memory across runs are bounded at 256 MB, the oldest dropped (the
disk keeps them, as it keeps installs). `.git/` and `node_modules/` in a repository are left out.

A git package's binaries are the project's: a dev script that runs one (`"dev": "tool"`) starts it
from the package's linked files, before an installed package's of the same name (`linkedBin`, for
workspaces and `file:` packages too). A `semver:` range takes the lockfile's commit while the locked
version is in it.

### Errors

| What | Class |
|---|---|
| Repository, branch, tag, commit or `semver:` range not there (`git: x@user/repo: no branch or tag named "nope"`) | `app-bug`, `unresolvable-dependency`, in the install phase |
| No package.json at the repository's root (or its `path:`) | `app-bug` |
| A host, shape or size Sandburg does not fetch | `runtime-unsupported`, in the probe (the size: in the install) |
| The network | the install phase's, as a registry failure is |
| Offline (`SessionOptions.offline`), and the commit or ref not fetched before | the install phase's; a full commit id fetched before needs no network |

## Consequences

- `AdapterDescriptor` gains an optional `sources(project, { offline, log })`; the session calls it
  before the host's install and the mount, while the tab loads, and mounts what it returns (without
  the fetched files if it failed, so that the install phase reports the failure).
- `InstallPlan` gains `git`, the git dependencies not fetched yet. The host's install and the browser
  install refuse a plan with any (they were not fetched).
- A package-lock.json's entries for git dependencies (npm's clones, with `git+…#<commit>` versions)
  are dropped from what npm installs, with what is nested under them; their commit is the one fetched.
- New dependency: isomorphic-git (ls-refs, and clones from other hosts).
- Tests: `test/unit/git-packages.test.ts` (the shapes, a fake GitHub: one listing and one archive,
  nothing on a second run, the lockfile's commit, redirects, not-found classes, offline);
  `test/unit/local-packages.test.ts` (pending and fetched plans); `test/e2e/monorepo.test.ts` (a tag
  and a `semver:` range from GitHub, with a registry dependency of their own, with either install).

## Not done

- Running a git dependency's `prepare` (in the page's runtime, where the app's own code runs, it
  could be: a follow-up if built-from-git packages turn out common).
- npm's `files`/`.npmignore` packing: the whole repository (minus `.git/` and `node_modules/`) is the
  package.
- Private repositories (credentials), gists, and git dependencies of registry packages.
