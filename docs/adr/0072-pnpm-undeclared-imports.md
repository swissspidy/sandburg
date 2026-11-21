# ADR 0072: pnpm projects: an import of a package the project does not declare fails, as with pnpm

- Status: Accepted
- Date: 2026-11-21

## Context

Sandburg installs every project with npm (ADR 0064 pins a pnpm-lock.yaml's versions, but npm lays
out node_modules). npm hoists every package to the top of node_modules, so an app's file can import a
package that only one of its dependencies brings (`scheduler`, `react-dom`'s) and it resolves.
pnpm's default layout is isolated: the project's node_modules holds only what package.json declares,
and a dependency's dependencies sit in `node_modules/.pnpm`. There, the same import resolves to
nothing.

So for a pnpm project, Sandburg passed apps that fail for everyone who installs them the way the
project says to. Generated apps hit this: an agent that follows the Next.js docs runs their first
command, `pnpm create next-app`, and gets a pnpm project (a pnpm-lock.yaml, `"packageManager":
"pnpm@10.28.0"`, a pnpm-workspace.yaml listing build scripts to ignore). That scaffold, with one line
added to `app/page.tsx` (`import { unstable_now } from 'scheduler'`), measured:

- `pnpm dev` (Next.js 16.4.6, Turbopack): HTTP 500, `Module not found: Can't resolve 'scheduler'`;
- `sandburg run`: passed.

The source check (ADR 0067) already finds imports of packages the project does not declare, but only
after the ready phase has gone 20 s without a render, and it counts every package a pnpm-lock.yaml
lists as installed, which is npm's layout, not pnpm's.

## What pnpm does, framework by framework

Each fixture installed by pnpm 10.28 (isolated, the default), one import of a package a dependency
brings and the project does not declare added, and the real dev server asked for the page or module
(2026-11-21; Node's `require.resolve` finds none of the packages from the project):

| Framework | Import | pnpm dev |
|---|---|---|
| Next.js 16.4.6 (`pnpm create next-app`) | `scheduler` in `app/page.tsx` | 500, `Module not found: Can't resolve 'scheduler'` |
| Vite 8 + React | `scheduler` in `src/main.tsx` | 500, `Failed to resolve import "scheduler"` |
| Vite 8 + Vue | `@vue/shared` in `src/main.js` | 500, `Failed to resolve import "@vue/shared"` |
| SvelteKit 3.4 | `devalue` in `src/routes/+page.svelte` | 500, `Cannot find module 'devalue'` |
| Astro 7.4 | `html-escaper` in `src/pages/index.astro` | 500, `Cannot find module 'html-escaper'` |
| SolidStart 2.2 | `seroval` in `src/routes/index.tsx` | the page never finishes (as SolidStart does on any unresolvable import, ADR 0067) |
| React Router 8.5 | `@remix-run/route-pattern` in `app/routes/home.tsx` | 500, `Cannot find module '@remix-run/route-pattern'` |
| Angular 22.3 (`ng serve`) | `mrmime` in `src/main.ts` | bundle generation fails, `TS2307: Cannot find module 'mrmime'` |
| Nuxt 4.6 | `h3` in a server route; `ofetch`, `defu` and `picomatch` (a transitive package) in pages and routes | **200**: resolved |

Nuxt resolves a package from anywhere in the install, under pnpm too: an undeclared import there runs. Every
other framework Sandburg supports fails it. (The Angular CLI writes `"packageManager": "npm@…"`
into a new project, which pnpm refuses to install; the fixture was measured without it, as
`ng new --package-manager pnpm` writes it.)

## Decision

- **A pnpm project with an isolated layout is recognised** (`pnpmStrict`, `source-check.ts`): it has a
  pnpm-lock.yaml, or its package.json's `packageManager` says pnpm, and it has no package-lock.json
  (from which Sandburg installs) and no `packageManager` naming another tool. Not when pnpm is told to
  hoist (`shamefully-hoist=true`, or a `node-linker` other than `isolated`, in .npmrc or
  pnpm-workspace.yaml), and not when the app that runs uses Nuxt (above): its package.json or the
  root's, not a sibling workspace package's (a monorepo's Nuxt docs beside its Next.js app).
- **There, the source check counts as installed only what pnpm puts in the project's node_modules**:
  what package.json declares (as before, each package.json from the file up), and what
  `public-hoist-pattern` matches (.npmrc or pnpm-workspace.yaml; by default nothing since pnpm 10,
  `*eslint*` and `*prettier*` when `packageManager` names pnpm 9 or older), read as pnpm 10's matcher
  reads it (`publiclyHoisted`): in order, a matching pattern includes a package and a later matching
  `!` exclusion takes it out; a list of exclusions only hoists every other package. A pnpm-lock.yaml's
  other packages no longer count, and neither does one npm installed that pnpm would not hoist.
- **The check starts with the ready phase, and an undeclared import in a file the app read fails the
  phase once the app has rendered** (`failOnUndeclaredWithPnpm`, `app-ready.ts`). What the app read is
  what its runtime recorded (ADR 0067): a file only another route imports was not read, and does not
  fail the run, as pnpm's dev servers compile only what is asked for. That npm installed the package
  anyway no longer excuses it (`relevantFindings`). The error is Node's, `Cannot find package 'x'
  imported from file:line`, with what pnpm does and what to add to package.json, so classify() takes
  it for an undeclared import: `app-bug`, `undeclared-import`, in `ready`.
- **What does not change**: npm, yarn and bun projects (their layouts hoist); a pnpm project's
  install, which npm still lays out (dependencies resolve their own dependencies as under pnpm's
  `node_modules/.pnpm`); dynamic `import()` and `require()`, which the source check does not follow
  (an app may guard them).

## Results

- The `pnpm create next-app` scaffold above passes (cold 28 s, warm 15 s). With the `scheduler`
  import it fails: `app-bug in ready [undeclared-import]: imports undeclared package "scheduler"`. The
  same app with its pnpm files removed (an npm project) passes, as `next dev` runs it after `npm install`.
- `test/e2e/run.test.ts`: the Vite + React fixture with `"packageManager": "pnpm@10.28.0"` and the
  `scheduler` import fails in `ready` as `undeclared-import`; without the `packageManager`, it passes
  its checks.

## Consequences

- An app that passed before can fail now: a pnpm project that imports what it does not declare. That
  is what its users get from `pnpm install`; the failure says which package and where.
- Frameworks that resolve like Nuxt are listed by measurement (`PNPM_LENIENT`), not inferred: a
  framework that does so and is not listed gives a false alarm, which a fixture installed by pnpm
  shows. A new framework, or a new major of one, is measured the same way.
- Imitating pnpm's layout itself (symlinks into `node_modules/.pnpm`) was not done: every bundler and
  the runtime resolve through the file system, and the layout would change what every install,
  store and warm start shares. The static check covers the case that matters (an app's own import),
  in a run that otherwise stays as it was.
