---
"sandburg": patch
---

A project with a `bun.lock` (and no `package-lock.json`) installs at the versions it locks, as one with a `pnpm-lock.yaml` or `yarn.lock` does: each workspace's direct dependencies at their locked versions, and the packages locked in one version pinned with overrides. Before, the lockfile was ignored and the ranges in package.json installed the newest versions. Dev scripts that run `bunx <bin>` or `bun x <bin>` run the package's binary with Node, as `npx` does; before, they exited with 127.
