---
"sandburg": minor
---

A pnpm project that imports a package it does not declare fails, as it does with pnpm. Sandburg installs with npm, which hoists every package to the top of node_modules, so an app could import a package only one of its dependencies brings (`scheduler`, from `react-dom`) and pass, while `pnpm install` gives the project only what package.json declares, and its dev server fails the page (Next.js: `Module not found: Can't resolve 'scheduler'`). For a project with a pnpm-lock.yaml or `"packageManager": "pnpm@…"` (not hoisted with `shamefully-hoist` or `node-linker=hoisted`), the ready phase now fails on such an import in a file the app loads, as an app bug (`undeclared-import`) that names the package and the file. Packages pnpm hoists publicly (`public-hoist-pattern`) count as installed, and Nuxt projects are left as they were: Nuxt resolves an undeclared package under pnpm too.
