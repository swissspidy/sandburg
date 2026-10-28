# ADR 0067: Diagnosis follow-ups: a page's later 5xx, error-named paths, and checking the sources of an app that hangs

- Status: Accepted
- Date: 2026-10-28

## Context

ADR 0066 left three gaps in how the ready phase fails fast and how a failure is classified:

- **A same-URL 5xx after a cold start was swallowed.** The fail-fast watch (`failFastOnAppError`,
  `orchestrator/app-ready.ts`) leaves Chromium's console error for the app's page's own failed load
  ("Failed to load resource: the server responded with a status of 500") to its server-error rule,
  which checks again after 8 s whether the page has recovered. It dropped every such entry whose URL
  was the page's, once the page had ever answered a 5xx. Chromium logs the same text, with the same
  URL, for any request to that URL: a POST from a Next.js server action, htmx or Turbo. So after a
  cold start's 500 and a reload's 200, the app's own POST to its page answering 500 went unseen, and
  the phase ran to its deadline. Chromium 153's sequence, recorded with Playwright's `response` and
  `console` events for a frame whose page answers 500, then 200 with a script that posts to
  `location.href` and gets 500: `doc 500`, `console error "Failed to load resource: … 500 (Internal
  Server Error)" <url>`, `doc 200`, `console error "Failed to load resource: … 500 (Internal Server
  Error)" <url>`.
- **A path segment named `Error` counted as a thrown error.** `thrown()` in `classify.ts` takes a
  console error that names `<Name>Error:` or `<Name>Exception:` on its first line for a thrown
  error. "Loaded module src/components/Error: ok" matched.
- **SolidStart 2.1.0 hangs on a syntax error or an undeclared import** (corpus apps 148 and 203).
  Under real npm it starts streaming the page, never ends it, and logs nothing on the server or in
  the page. Under Sandburg the run's last output is Vite's client connecting; the ready phase waited
  out its 240 s and the run was a `timeout`, with nothing to say what was wrong.

## Decision

- **Each of the page's own 5xx loads accounts for one console error for its URL.** Chromium's
  "Failed to load resource: … 5xx" entry for URL X is the page's load only while the number of the
  app's such entries for X so far (not the host page's), that one included, is no more than the
  number of the app frame's 5xx documents for X. A later one is the app's own request failing, and fails the phase after the
  console-error grace period (8 s). An app error seen while the page's server error waits to be
  checked again is kept: if the page has recovered at that check, the app error's own deadline
  applies (the run above fails 8 s after the POST's error, not 8 s after the recheck).
- **An `Error` or `Exception` token right after `/` or `\` is a path, not a thrown error.** `Error:
  x`, `Uncaught (in promise) TypeError: …`, `[nuxt] error caught during app initialization
  TypeError: …`, `DOMException: …`, `ERROR TypeError: …` and a namespaced
  `Prisma.PrismaClientKnownRequestError: …` still count; React's warnings are still left out.
- **The app's sources are checked when the ready phase stalls, and fail it only while its page
  hangs** (`source-check.ts`, `failOnSourceStall` in `orchestrator/app-ready.ts`), in a way that
  does not depend on the framework:
  - *Which files.* Only the app's: those reachable from its entries and its frameworks' file-based
    roots. The entries are an HTML page's `<script src>`s, files named `main.*`, `index.*`,
    `entry-client.*`, `entry-server.*`, `app.*`, `hooks.*`, `middleware.*` or `server.*` at the
    app's root or in `src/`, package.json's `main` and `module`, and the project files its `dev`,
    `start` and `serve` scripts name. The roots are `app/`, `pages/`, `src/routes/`, `src/pages/`,
    `src/app/` with a Next.js config, and with a Nuxt config Nuxt's auto-imported directories
    (`components/`, `composables/`, `utils/`, `layouts/`, `pages/`, `plugins/`, `middleware/`,
    `server/`, at the root or in `app/`) and `app.vue`. From them every import (static, `import()`,
    `require()`) is followed to the project's files: relative, from the app's root (`/src/x`),
    tsconfig.json `paths` and `baseUrl`, package.json `imports` (`#lib/*`), `$lib`, `~`/`@` and
    `~~`/`@@`, and workspace packages (their `source`, `exports`, `module`, `main` or `src/index`).
    A script (`scripts/seed.ts`), an example, a file nothing imports, `node_modules`, dot
    directories, `dist`, `build`, `out`, `coverage`, `public`, `static`, tests, test setup files
    (`test-setup.*`, `setup-tests.*`, `setupTests.*`, `vitest.setup.*`, `jest.setup.*`), stories and
    `.d.ts` files are not looked at. For a monorepo the entries are the running package's
    (`Project.app`).
  - *Parsing.* One esbuild build per TypeScript configuration (the native esbuild Sandburg already
    uses on the host), every import external, nothing written. Each file is parsed with its nearest
    tsconfig.json's (or jsconfig.json's) `experimentalDecorators`, `useDefineForClassFields`,
    `verbatimModuleSyntax` and JSX options, with what it `extends` within the project: Angular's and
    Nest's parameter decorators and Lit's `@property() declare foo` need `experimentalDecorators`.
    Components' scripts (Vue's and Svelte's `<script>` blocks, Astro's frontmatter and its processed
    `<script>`s, each a module of its own, blanked around so lines and columns are the file's) keep
    every import, as their compilers keep what the template uses. `<script>` start tags are read in
    one pass that skips quoted values and `{…}` expressions (Vue's `generic="T extends Record<string,
    unknown>"`, Svelte's `generics`, Astro's `define:vars={{ b: a > 0 }}`); a self-closing `<script
    … />` has no content; Astro's frontmatter runs from its first line to the next line that is
    `---`, and its top-level `return`s are rewritten to `if(1) ` (the same length) so it parses as a
    module. An error that only ESM's strict mode makes (a classic script's `with`) is checked again
    with the file parsed as a script.
  - *Findings.* A reachable file that does not parse is a `compile-error` at its first error's file,
    line and column. A reachable file's static import (`import … from`, `export … from`; not
    `import()` or `require()`, which an app may guard) of a package is an `undeclared-import`, at the
    import's line, unless: a package.json from the file's directory up declares it (all four
    dependency fields), it is a workspace package, a lockfile lists it as installed where the file
    can import it (`node_modules/<name>` at the root or the file's workspace in package-lock.json,
    any package in yarn.lock, pnpm-lock.yaml or bun.lock: npm hoists what dependencies need, ADR
    0004's phantom dependencies), an import map or the build tools' configs name it (a quoted name or
    a key in `vite.config.ts`), or it is not a package: a Node built-in, a relative or absolute path,
    a scheme (`node:`, `virtual:`, `astro:`, URLs), an alias above, a `baseUrl` directory
    (`components/…`), or an asset (`.css` and other non-script extensions, a `?raw` query: `uno.css`,
    `@unocss/reset/tailwind.css`). TypeScript's elided imports (types, and imports nothing uses) do
    not count. Next.js's `server-only`, `client-only` and `styled-jsx` are provided by Next.js.
  - *Cost.* The check runs on a worker thread, with a 10 s budget (nothing found when it is spent),
    and only on the files it reads, each size-capped on the host's thread before they are sent:
    source, page, config and manifest files 512 KB each, lockfiles 16 MB, 2,000 source files and
    64 MB in all. Its scans are linear (a `<script` tag's end is found with `indexOf`), and a
    component's scripts are at most 16.
  - *When it fails the phase.* The sources are checked once the ready phase has run 20 s without
    the app rendering: a run whose app renders sooner never checks them. What is found fails the
    phase only while the page hangs: the app frame's latest document answered 2xx and its body has
    not ended (SolidStart streams the page and never ends it), it is not a loading page (Nuxt's
    503), and the dev server (the runtime's output) and the page (its errors) have said nothing for
    10 s. An app whose page has not been answered yet is still compiling (`next dev` says
    "Compiling / ..." once, then nothing until it answers): it runs to the phase's deadline. The
    message is "app did not render, and its sources have an error: <file:line:column: message>" or
    "…: imports undeclared package "<name>" (<file:line>)".
  - *Classification.* A ready phase that failed that way, or timed out after the check found
    something, is `app-bug` with the finding's rule (`compile-error` or `undeclared-import`) and
    `<file:line:column>: <message>` or `imports undeclared package "<name>" (<file:line>)`, unless
    Sandburg's own machinery failed (an infra error, a broken download): then the findings change
    nothing. Rules that read the dev server's own report come first.

## Results

- **148 and 203** (`corpus/`, run with their checks, the node runtime and Chromium 153; cold is an
  empty working directory, so empty Sandburg stores, npm's own cache warm):

  | App | Before (v7 study) | Now, cold | Now, warm |
  |---|---|---|---|
  | 148 (syntax) | `timeout` after 242 s | `compile-error` `src/components/ConverterFeature.tsx:3:16: Unexpected ";"`, 38.9 s (ready 20.3 s) | the same, 21.9 s (ready 20.3 s) |
  | 203 (undeclared import) | `timeout` after 242 s | `undeclared-import` `imports undeclared package "dayjs" (src/components/CounterFeature.tsx:3)`, 28.0 s (ready 20.5 s) | the same, 21.8 s (ready 20.3 s) |

- **A slow, healthy app is left to render** (`test/e2e/run.test.ts`): a server that says it is
  compiling once and answers its page after 28 s, with a reachable file (imported only by a route
  the run never asks for) that imports an undeclared `@faker-js/faker`, passes its ready phase at
  28 s. Without the hanging-page condition it failed at 21 s as `undeclared-import`. Beside it, a
  server that answers 200, streams the page's start and never ends it, with a reachable file that
  does not parse, fails at about 20 s as `compile-error` with that file's line and column.
- **No false positives on the corpus.** Over all 232 corpus apps, the check flags exactly the 29
  seeded faults, each at the line the generator seeded: the 15 syntax errors (`const broken = ;`, in
  `.ts`, `.tsx`, `.js`, `.vue` and `.svelte` files) and the 14 undeclared imports (v6's `nanoid`, v7's
  `dayjs`), and nothing in the other 203 apps (`test/unit/corpus.test.ts`, which reads each app's
  fault from its meta.json). The repo's 20 fixtures have no findings either.
- **Real repositories.** Shallow clones of vercel/commerce, antfu/vitesse, elk-zone/elk,
  nuxt/movies, gothinkster/angular-realworld-example-app, solidjs/solid-start and
  nestjs/typescript-starter have no findings (each 9–201 ms). With a syntax error put into each of
  26 of their source files in turn, 20 are reported at that file; the 6 not reported are files only
  a build plugin reaches (vitesse's `import.meta.glob`'d modules, its auto-imported components,
  layouts and stores) and a fixture of the solid-start repository's own monorepo, which is not the
  app. Their patterns are unit tests (`test/unit/source-check.test.ts`): `baseUrl` imports, a
  virtual stylesheet, Vue's and Svelte's generics, Astro's expressions and self-closing scripts,
  legacy decorators, hoisted packages in each lockfile format, a peer of a workspace package, test
  setup files, a classic script's `with`.
- **Cost.** A corpus app takes a median of 6.8 ms (95th percentile 13 ms, at most 23 ms), and a
  call on its worker thread about 100 ms in all. A 508 KB `.vue` file of 65,000 unclosed `<script>`
  tags takes 258 ms (before: about 11 s, synchronously, on the host's main thread), and an 898 KB
  page of 39,000 import-map tags 8 ms when read (before: 13.3 s); over the 512 KB cap it is not
  read at all.
- **Healthy runs are not slower.** `scripts/bench.ts` (origin/main against this change, 3 rounds,
  medians, a 4-vCPU machine): vite-react-counter 6.12 s → 5.93 s cold, 1.61 s → 1.59 s warm;
  lit-vite 4.95 s → 5.01 s cold, 1.42 s → 1.30 s warm; next-app-router 23.87 s → 22.29 s cold,
  4.40 s → 4.49 s warm: within the runs' noise. None of these apps' ready phases reaches 20 s, so
  their sources are never checked.
- **The POST after a cold start** (`test/e2e/run.test.ts`): a server that answers its page's first
  load 500, then a blank page whose script posts to its own URL and gets 500, fails the ready
  phase in 17 s with that console error. Before: the 60 s deadline.

## Consequences

- An app whose page hangs with no output on a syntax error or an undeclared import fails in about
  20 s of ready, with the file and line, whatever its framework. One whose page is never answered
  runs to the deadline as before, and its timeout is classified by what the check found.
- A reachable file that does not parse, or a reachable import of a package that is neither declared
  nor installed, still fails an app whose page hangs for another reason (a server render that waits
  on a backend that never answers). The corpus and the real repositories above have none.
- The check misses what it cannot follow: files a build plugin imports (`import.meta.glob`,
  auto-imported components outside Nuxt), dynamic `import()` and `require()` of packages, and files
  past its caps. A missed fault leaves the run as it was before this change (a timeout).
- A page whose own 5xx documents and requests to its own URL interleave is judged by count, not by
  which request Chromium's entry is about; Chromium's entry does not say.
