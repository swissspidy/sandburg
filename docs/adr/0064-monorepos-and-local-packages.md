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
  dependencies only, and a local package's non-optional peer dependencies (npm 7 and later install
  them) unless something installs that package already. Optional dependencies are left out for
  every package, local or not, as the install leaves them out (`--omit=optional`; WebAssembly builds
  replace native ones).
- **One copy where one version serves.** Two packages' ranges of a dependency share the copy at the
  root when one version can satisfy both: with a package-lock, when its locked version does; without
  one, when the ranges intersect (the root's spec becomes both ranges, `^18.2.0 ^18.3.1`, so npm picks
  a version in both). Two copies of a package such as React in one app do not work. Only a range
  that copy cannot serve goes into the local package's own node_modules: a second install, combined
  with the root's under one key as `client/` and `server/` packages already are
  (`Installer.combine`), from the package-lock's own entries under that package's node_modules when
  it has them, or from the ranges.
- **Each local package is linked where npm would link it**: every workspace at
  `node_modules/<name>` (unless a registry package of that name has the top), a `file:`/`link:`
  dependency at `node_modules/<alias>`, or in its dependent's node_modules when the top is taken.
  `workspace:*`, `workspace:^1`, `workspace:<alias>@*` and `workspace:<path>` name a workspace; a
  plain range names one too when that workspace's version satisfies it, as npm links them.
- **npm gets what is left, which is registry versions only.** The Installer's checks
  (`assertRegistryManifest`, `assertRegistryLockfile`) still run on what it is given, unchanged: a
  project's own `file:` spec given to it directly is refused as before. A project's package-lock.json
  loses its local packages' entries (their `link` entries and directories, and the v2 lockfile's
  back-compat tree; in a v1 lockfile, the entries whose version is a `file:` or `link:` to one of
  them); every other entry is checked as any lockfile is, so a `link` to anything
  that is not one of the project's local packages is still refused.
- **The boundary is the project's root.** A path that leaves it (`../x`, `/abs`, `~/x`, through
  `..` from a workspace) is refused as `runtime-unsupported`, naming the dependency ("…: it points
  outside the project"), as is a local tarball (`file:x.tgz`, which npm would unpack and could
  prepare). Nothing outside the project's files is read: a local package's files are the project's
  files. A local package that is not there (no package.json at the path, no workspace of that name,
  two workspaces with one name) is the app's mistake (`app-bug`), worded as npm and pnpm word it, as
  is a workspace's or a dependency's name that is not a package name (npm's
  `EINVALIDPACKAGENAME`): the name is where it is linked or installed.
- **The plan is worked out once per project** (`planOf`, by its files): the probe, the install and
  the warm check share it.

### The runtime links them as a symlink would

The page writes the plan's links and workspace packages into `.sandburg/workspace.json`
(`src/node-runtime/links.ts`). The runtime, as it starts, puts each linked package's files at its
link (`/app/node_modules/@acme/ui/…`, the same bytes; not the package's own node_modules), and
resolves the link to the package's directory, as Node does through npm's symlink: module resolution
(`Module._resolveFilename`) and `fs.realpath` return `/app/packages/ui/…`. So a module of a local
package loads once, whichever path reaches it; it finds its own dependencies (a version installed in
its node_modules) from its own directory; and a dev server sees it as source, not as an installed
package (Vite does not pre-bundle a linked package). A thread or child process sees the links
through its parent's file system.

A link the runtime takes must be a package's place in a node_modules directory and point to a
directory inside the project (`safeLinks`); a project's own `.sandburg/` files are left out however
the project is loaded (`projectFromFiles`, as the directory and zip loaders already did), and the
page writes the file only from the host's plan, so only the host's links reach the runtime.

The VFS gains no symlinks: the copies are the files a `readdir` or `stat` of node_modules meets, the
realpath is what module identity and dev servers use. So `fs.lstat` and `fs.readlink` of a link see
a directory, not a symlink, and its files are copies: a file the app writes into the package's
directory after the start is at its real path, not at its link.

### A workspace package runs in its monorepo

- `sandburg run mono/apps/web` loads the monorepo when a directory above `apps/web` declares
  workspaces that name it (`src/project.ts`): the project is the monorepo's files (all of them: its
  other packages, and the root's own files, `.env` files included, as a run of the root reads them),
  and
  `Project.app` (new, optional) is `apps/web`. It runs `apps/web`'s `dev` (or `start`) script in
  its directory (`npm --prefix apps/web run dev` through the runtime's shell). A directory with a
  package.json that no workspace pattern names is loaded alone, as before. The framework is the
  root's (framework knowledge such as seeds and Next.js' programmatic start assumes the app at the
  root); a workspace app starts through its dev script.
- The runtime's shell, and the host's reading of dev scripts (`expandScript`), run a workspace's
  script by name or path: `npm run dev -w web` (`--workspace`, `--workspace=`), `pnpm --filter web
  dev` (`-F`, `./path`, `{path}`), `yarn workspace web dev`. A script for every workspace
  (`--workspaces`, `pnpm -r`) is not run (exit 127, with a message) rather than the root's own
  script again; nor is a pnpm selector that picks packages by the graph or a pattern (`web...`,
  `./apps/*`, `@scope/*`, `!web`), nor a workspace the project does not have (exit 1, naming the
  selector or name).
- A pnpm-workspace.yaml without `packages` (pnpm 10 writes one for settings such as
  `onlyBuiltDependencies`) declares no workspaces: such a project's `client/` and `server/`
  packages are installed as before.

### pnpm-lock.yaml and yarn.lock pin versions

Without a package-lock.json (or npm-shrinkwrap.json), a pnpm-lock.yaml (v5, v6, v9) or yarn.lock
(classic, berry) is read (`src/adapters/node/lockfile-pins.ts`; pnpm's YAML through
`src/yaml-lite.ts`, the subset pnpm writes). Their trees are not npm's (pnpm's is isolated, yarn's
entries are descriptors, not locations), so they are not translated into a package-lock:

- **Each package's direct dependencies are pinned** to the version the lockfile resolved for that
  package and range (pnpm: its importer; yarn: the `name@range` descriptor), when it still satisfies
  the range in package.json as npm reads it (no prerelease a range would not pick); a lockfile older
  than package.json is not used for that dependency. An alias (`"x": "npm:other@^1"`) is not pinned.
- **Every other package the lockfile has in exactly one version is pinned to it**, with an
  `overrides` entry, when every direct dependency was pinned. With the direct dependencies at their
  locked versions, the ranges below them are the ones the lockfile was resolved against, which that
  one version satisfied; with one that is not (a package.json newer than its lockfile), that no
  longer holds, and nothing below is pinned. Packages in several versions are left to their ranges.
  No override is added for a package the project names itself (npm refuses an override that differs
  from a direct dependency's spec) or overrides itself.
- **Lockfile aliases are pinned by their real package name.** A yarn.lock descriptor
  `"string-width-cjs@npm:string-width@^4.2.0"` is a version of `string-width`; no pin or override is
  keyed by an alias, and a name that is not a package name is never pinned.
- **Warm starts.** An install records which overrides are pins (`sandburgPins` in its package.json);
  the closest install that lends its lockfile (ADR 0032) is chosen by the project's own overrides,
  and a pinned version counts as the same spec as a range it is in. npm applies this install's pins
  to the tree it lends (checked: a lent lockfile's `ms` 2.1.3 becomes the override's 2.1.2). A
  project with a yarn.lock (vite-react-counter's dependencies and `ms`, 49 packages pinned, after an
  install of the same dependencies without it; `Installer.install`, fresh process, 3 rounds): 1.23–1.42 s
  without a warm start, 0.54–0.59 s with one, every version still its pin.

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
  (`inside()` refuses absolute, home-relative and escaping paths, and backslashes). A link's place is
  a package name in a node_modules directory: a workspace or dependency whose name is not a package
  name is refused by the plan, and the runtime takes only links of that shape, to directories inside
  the project (`safeLinks`), from the host's plan alone (a project's own `.sandburg/` never reaches it). A link in a
  project's package-lock.json is dropped only when it points to one of the project's local packages;
  any other stays and is refused.
- Loading a workspace package from its directory reads its monorepo's root, a directory above the
  one given, only when that root's own workspace patterns name the directory (as npm, pnpm and yarn
  would install it).
- Lockfile pins are versions and plain overrides: registry specs, checked as any spec is. A version
  that is not a valid semver version (links, aliases, tarballs, git) is never pinned, nor is a name
  that is not a package name; aliases are pinned by their real package name.
- pnpm-workspace.yaml and pnpm-lock.yaml are read by a small YAML reader that stops at a nesting
  depth of 100 and sets every key as an own property, `__proto__` included.
- In the runtime, the links are the page's own data about the project's files; a link is a path
  rewrite inside the sandbox's file system, which already holds every file it can reach.

## Consequences

- Fixtures `monorepo-workspaces` (npm workspaces, a `file:` package outside them, an npm
  package-lock.json pinning a hoisted dependency that the app and a workspace both use, through
  different but compatible ranges, as one copy, an app in `apps/web` started by the root's `npm run
  dev --workspace=web`) and `pnpm-lock-app` (pnpm-workspace.yaml, `workspace:*`, `link:`, a
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
- pnpm's `catalog:` protocol (a follow-up), `patch:` and `portal:`, and pnpm's isolated layout (a
  workspace's dependencies are visible only to it); the hoisted layout npm uses is what a workspace
  gets.
- A workspace directory that is a symlink on disk is skipped (the directory loader follows no
  symlinks), as are symlinks inside the project.
- Translating pnpm or yarn lockfiles exactly (every package at its locked version wherever it is in
  the tree) would mean writing a package-lock from another tool's tree; the pins above are the
  versions that are sound to pin without that.
