# ADR 0064: Monorepos and local packages; pnpm and yarn lockfiles

- Status: Accepted
- Date: 2026-10-28

## Context

Since ADR 0054, the host installs registry dependencies only: npm (through pacote) *prepares* a git
or directory dependency, running its `prepare` script on the host whatever `--ignore-scripts` says,
so every spec that names a protocol or a path is refused before npm runs. The browser install
(ADR 0018) refuses the same specs. That rule left out the shapes most real projects use:

| | Before |
|---|---|
| (a) `file:`/`link:` dependencies inside the project | Refused at install as `runtime-unsupported` (host and page), worded as for git and URLs. |
| (b) Workspaces (`workspaces` in package.json, pnpm-workspace.yaml) | npm workspaces: only the root's own dependencies were installed (npm got a copy of the root's dependencies, without `workspaces`), so no workspace's dependency was there, and no workspace package was in node_modules. A root dev script `npm run dev --workspace=web` ran the root's own `dev` again, without end ("Maximum call stack size exceeded", an `app-bug`). `workspace:*` (pnpm, yarn) was refused as `runtime-unsupported`. A workspace package run on its own (`sandburg run mono/apps/web`) was refused for its `file:` or `workspace:` dependencies, or, with plain ranges, installed its siblings from the registry. A package-lock.json of an npm monorepo was refused (its `link` entries). |
| (c) A pnpm-lock.yaml or yarn.lock without a package-lock.json | Ignored: the ranges resolved to the newest versions (`ms@^2.0.0` locked at 2.0.0 installed 2.1.3), reported as `resolution: range`. |
| (d) git, URL and `user/repo` dependencies | Refused as `runtime-unsupported` in the install phase, after the browser had launched, with one message for every kind ("only registry versions can be installed (not files, links, git or URLs)"). |

## Decision

### Local packages never reach npm

A **local package** is a workspace (a directory a root's `workspaces` or pnpm-workspace.yaml names,
with a package.json) or the directory a `file:`, `link:` or `workspace:` dependency, or a bare
relative path, points to inside the project. `installPlan` (`src/adapters/node/local-packages.ts`,
pure: the host's install and the page's use it) takes them out of what npm installs:

- **Their registry dependencies are installed with the root's**, as npm hoists a workspace's: the
  root, then every workspace, then each package a `file:`/`link:` dependency reaches, in that order;
  a workspace's and the root's devDependencies too (npm installs them), a `file:` package's
  dependencies only. A package a local package needs in another version than the one at the root
  goes into that package's own node_modules: a second install, combined with the root's under one
  key as `client/` and `server/` packages already are (`Installer.combine`).
- **Each local package is linked where npm would link it**: every workspace at
  `node_modules/<name>` (unless a registry package of that name has the top), a `file:`/`link:`
  dependency at `node_modules/<alias>`, or in its dependent's node_modules when the top is taken.
  `workspace:*`, `workspace:^1`, `workspace:<alias>@*` and `workspace:<path>` name a workspace; a
  plain range names one too when that workspace's version satisfies it, as npm links them.
- **npm gets what is left, which is registry versions only.** The Installer's checks
  (`assertRegistryManifest`, `assertRegistryLockfile`) still run on what it is given, unchanged: a
  project's own `file:` spec given to it directly is refused as before. A project's package-lock.json
  loses its local packages' entries (their `link` entries and directories, and the v2 lockfile's
  back-compat tree); every other entry is checked as any lockfile is, so a `link` to anything
  that is not one of the project's local packages is still refused.
- **The boundary is the project's root.** A path that leaves it (`../x`, `/abs`, `~/x`, through
  `..` from a workspace) is refused as `runtime-unsupported`, naming the dependency ("…: it points
  outside the project"), as is a local tarball (`file:x.tgz`, which npm would unpack and could
  prepare). Nothing outside the project's files is read: a local package's files are the project's
  files. A local package that is not there (no package.json at the path, no workspace of that name,
  two workspaces with one name) is the app's mistake (`app-bug`), worded as npm and pnpm word it.

### The runtime links them as a symlink would

The page writes the plan's links and workspace packages into `.sandburg/workspace.json`
(`src/node-runtime/links.ts`). The runtime, as it starts, puts each linked package's files at its
link (`/app/node_modules/@acme/ui/…`, the same bytes; not the package's own node_modules), and
resolves the link to the package's directory, as Node does through npm's symlink: module
resolution (`Module._resolveFilename`) and `fs.realpath` return `/app/packages/ui/…`. So a module of
a local package loads once, whichever path reaches it; it finds its own dependencies (a version
installed in its node_modules) from its own directory; and a dev server sees it as source, not as an
installed package (Vite does not pre-bundle a linked package). A thread or child process sees the
links through its parent's file system. The VFS gains no symlinks: the copies are the files a
`readdir` or `stat` of node_modules meets, the realpath is what module identity and dev servers use.

### A workspace package runs in its monorepo

- `sandburg run mono/apps/web` loads the monorepo when a directory above `apps/web` declares
  workspaces that name it (`src/project.ts`): the project is the monorepo's files, and
  `Project.app` (new, optional) is `apps/web`. It runs `apps/web`'s `dev` (or `start`) script in
  its directory (`npm --prefix apps/web run dev` through the runtime's shell). A directory with a
  package.json that no workspace pattern names is loaded alone, as before. The framework is the
  root's (framework knowledge such as seeds and Next.js' programmatic start assumes the app at the
  root); a workspace app starts through its dev script.
- The runtime's shell, and the host's reading of dev scripts (`expandScript`), run a workspace's
  script by name or path: `npm run dev -w web` (`--workspace`, `--workspace=`), `pnpm --filter web
  dev` (`-F`, `./path`, `{path}`), `yarn workspace web dev`. A script for every workspace
  (`--workspaces`, `pnpm -r`) is not run (exit 127, with a message) rather than the root's own
  script again.

### pnpm-lock.yaml and yarn.lock pin versions

Without a package-lock.json (or npm-shrinkwrap.json), a pnpm-lock.yaml (v5, v6, v9) or yarn.lock
(classic, berry) is read (`src/adapters/node/lockfile-pins.ts`; pnpm's YAML through
`src/yaml-lite.ts`, the subset pnpm writes). Their trees are not npm's (pnpm's is isolated, yarn's
entries are descriptors, not locations), so they are not translated into a package-lock:

- **Each package's direct dependencies are pinned** to the version the lockfile resolved for that
  package and range (pnpm: its importer; yarn: the `name@range` descriptor), when it still satisfies
  the range in package.json (a lockfile older than package.json is not used for that dependency).
- **Every other package the lockfile has in exactly one version is pinned to it**, with an
  `overrides` entry. With the direct dependencies at their locked versions, the ranges below them are
  the ones the lockfile was resolved against, which that one version satisfied. Packages in several
  versions are left to their ranges. No override is added for a package the project names itself
  (npm refuses an override that differs from a direct dependency's spec) or overrides itself.

The host's npm and the browser installer both take pinned versions and plain overrides, so both
installs get the same versions. The install reports `resolution: lockfile`, `lockfileHonored: true`,
and the run's log says which lockfile pinned them.

### What cannot be installed is said before anything is

The node adapter's probe runs the plan: a git, URL, `user/repo`, local-tarball or outside-the-project
dependency, in the root, a workspace or a local package, fails the run in the **probe** phase as
`runtime-unsupported`, before the browser launches or anything is installed, with the dependency and
what it names (`x@user/repo: a GitHub repository (user/repo) dependency; only npm registry versions
and packages inside the project can be installed`). The install's checks stay as the second layer
(a registry package's transitive git dependency is still refused when npm has resolved the tree).

## After

| | After |
|---|---|
| (a) | Linked, with either install; their dependencies installed. Outside the project, or a tarball: `runtime-unsupported` in the probe. |
| (b) | npm, yarn and pnpm workspaces install and link, with either install; a root's `npm -w`/`pnpm --filter`/`yarn workspace` dev script runs the workspace's; `sandburg run mono/apps/web` runs the workspace in its monorepo; an npm monorepo's package-lock.json is honoured. |
| (c) | Versions pinned from the lockfile, with either install; reported as `lockfile`. |
| (d) | `runtime-unsupported` in the probe, naming the dependency and its kind. Not installed (below). |

## Security

- The host still runs npm over registry specs only; nothing new runs on the host. A local
  package is never fetched, packed or prepared by npm or pacote: the host reads nothing but the
  project's own files, which it already had, and the plan only moves registry specs between
  manifests. The Installer's own refusal of non-registry specs and lockfile entries is unchanged and
  still applies to what the plan gives it.
- The project root is the boundary for every link, from the root or from any local package
  (`inside()` refuses absolute, home-relative and escaping paths, and backslashes). A link in a
  project's package-lock.json is dropped only when it points to one of the project's local packages;
  any other stays and is refused.
- Loading a workspace package from its directory reads its monorepo's root, a directory above the
  one given, only when that root's own workspace patterns name the directory (as npm, pnpm and yarn
  would install it).
- Lockfile pins are versions and plain overrides: registry specs, checked as any spec is. A version
  that is not a valid semver version (links, aliases, tarballs, git) is never pinned.
- In the runtime, the links are the page's own data about the project's files; a link is a path
  rewrite inside the sandbox's file system, which already holds every file it can reach.

## Consequences

- Fixtures `monorepo-workspaces` (npm workspaces, a `file:` package outside them, an npm
  package-lock.json pinning a hoisted dependency, an app in `apps/web` started by the root's `npm
  run dev --workspace=web`) and `pnpm-lock-app` (pnpm-workspace.yaml, `workspace:*`, `link:`, a
  pnpm-lock.yaml pinning `ms` and `escape-html` below their newest); `test/e2e/monorepo.test.ts`
  runs both with either install, the workspace package from its directory, a Vite app in a
  workspace, and the unsupported specs. Runs of the fixtures take about as long as a single-package
  app's (0.9–1.6 s with warm caches).
- A project without local packages or another lockfile gets the same plan as before (the same
  manifest objects, so the same install key).
- A project with links pays for them in its threads: writing the linked files into node_modules
  tells threads that node_modules is no longer just the install (`trackNodeModulesWrites`: their fast
  answer for a path the install does not have), so they ask their parent.
- The copies of a linked package's files are made when the runtime starts: a file the app writes
  into a package's directory afterwards is not in its link (its realpath, which module resolution and
  dev servers use, is).

## Not done

- **git and URL dependencies stay unsupported.** npm would clone or fetch them and prepare them on
  the host (ADR 0054); fetching a tarball URL without preparing it, or a git archive from a host's
  API, would mean another fetcher with its own integrity story. Not straightforward, so left.
- Turborepo, Nx and Lerna as dev commands (`turbo run dev`) are native binaries or orchestrators,
  not supported; nor are scripts for every workspace (`npm run dev --workspaces`, `pnpm -r dev`).
- pnpm's `catalog:` protocol, `patch:` and `portal:`, and pnpm's isolated layout (a workspace's
  dependencies are visible only to it); the hoisted layout npm uses is what a workspace gets.
- Translating pnpm or yarn lockfiles exactly (every package at its locked version wherever it is in
  the tree) would mean writing a package-lock from another tool's tree; the pins above are the
  versions that are sound to pin without that.
