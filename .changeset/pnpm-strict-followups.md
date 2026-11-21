---
"sandburg": patch
---

pnpm projects: `public-hoist-pattern` exclusions count as pnpm counts them (`*` with `!scheduler` hoists every package but `scheduler`; exclusions alone hoist every other package), so an import of an excluded package fails. In a monorepo, only the app that runs (or the root) decides whether it uses Nuxt, so a Nuxt package beside a Next.js app no longer turns the check off for the Next.js app. A package npm installed and pnpm hoists publicly is not an undeclared import, also in a project without a pnpm-lock.yaml.
