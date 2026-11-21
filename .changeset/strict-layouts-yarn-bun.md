---
"sandburg": minor
---

Yarn's Plug'n'Play and Bun workspaces get the check pnpm projects have: an app that imports a package it does not declare fails, as an app bug (`undeclared-import`), as it does when its users install it. Yarn 2 and later use Plug'n'Play unless `.yarnrc.yml` sets `nodeLinker: node-modules`; Bun 1.3 and later isolate a workspace's packages unless `bunfig.toml` sets `linker = "hoisted"`. Sandburg installs with npm, which hoists every package, so such an import passed before. Yarn 1, a single Bun package and Nuxt projects are left as they were.
