---
"sandburg": minor
---

Monorepos and local packages: npm, pnpm and yarn workspaces, and `file:`, `link:` and `workspace:` dependencies on packages inside the project, are installed (on the host and with `--install-in browser`) and linked into node_modules, never given to npm; a root dev script that runs a workspace's (`npm -w`, `pnpm --filter`, `yarn workspace`) runs it, and `sandburg run mono/apps/web` runs a workspace package in its monorepo. Without a package-lock.json, a pnpm-lock.yaml or yarn.lock pins the installed versions. Git, URL and `user/repo` dependencies, local tarballs and paths outside the project now fail the run in its probe, before anything is installed, as `runtime-unsupported`, naming the dependency and what it is. `Project` gains an optional `app` (ADR 0064).
