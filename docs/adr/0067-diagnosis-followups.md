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
  number of the app frame's 5xx documents for X. A later one is the app's own request failing, and
  fails the phase after the console-error grace period (8 s). The app's errors are looked for while
  the page's server error waits to be checked again too, and when each was first seen is kept: if
  the page has recovered at that check, an error first seen after the page's latest document came
  keeps that time (the run above fails 8 s after the POST's error, not 8 s after the recheck), and
  one from before it, which the error page itself logged, has its grace from the recheck, as before.
- **An `Error` or `Exception` token right after `/` or `\` is a path, not a thrown error.** `Error:
  x`, `Uncaught (in promise) TypeError: …`, `[nuxt] error caught during app initialization
  TypeError: …`, `DOMException: …`, `ERROR TypeError: …` and a namespaced
  `Prisma.PrismaClientKnownRequestError: …` still count; React's warnings are still left out.
- **The app's sources are checked when the ready phase stalls, and classify it if it times out;
  they never end it early** (`source-check.ts`, `watchSources` in `orchestrator/app-ready.ts`,
  `sourceFailure` in `classify.ts`), in a way that does not depend on the framework:
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
    `.d.ts` files are not looked at, nor `main.*` elsewhere (`examples/demo/main.ts`). For a monorepo
    the entries are the running package's (`Project.app`).
  - *Parsing.* One esbuild build per TypeScript configuration (the native esbuild Sandburg already
    uses on the host), every import external, nothing written. Each file is parsed with its
    tsconfig.json's (or jsconfig.json's) `experimentalDecorators`, `useDefineForClassFields`,
    `verbatimModuleSyntax` and JSX options, with what it `extends` within the project: the nearest
    one, or for a solution-style one (Vite's: `files: []` and `references`) the referenced config
    whose `files` or `include` cover the file, as tsc and tsconfck choose. Angular's, Nest's and
    tsyringe's parameter decorators and Lit's `@property() declare foo` need `experimentalDecorators`;
    a file whose config extends one not in the project (a package's, `@tsconfig/…`), whose options are
    not all known, is parsed again with it before a decorator error counts. Components' scripts (Vue's
    and Svelte's `<script>` blocks, Astro's frontmatter and its processed `<script>`s, each a module
    of its own, blanked around so lines and columns are the file's) keep every value import, as their
    compilers keep what the template uses (`preserveValueImports`; an import of types only, `import {
    type X } from 'csstype'`, is not one). `<script>` start tags are read in one pass that skips quoted
    values, `{…}` expressions (Vue's `generic="T extends Record<string, unknown>"`, Svelte's
    `generics`, Astro's `define:vars={{ b: a > 0 }}`) and HTML comments (`<!-- <script>…</script>
    -->`); a self-closing `<script … />` has no content. Astro's frontmatter runs from its first line
    to the next line that is `---` outside a string, a template literal or a comment, and its
    top-level `return`s are rewritten to `if(1) ` (the same length) so it parses as a module. An
    error that only ESM's strict mode makes (a classic script's `with`) is checked again with the
    file parsed as a script. A file whose brackets nest deeper than 1,000 (counted in one pass) is not
    parsed: esbuild's parser would run out of stack.
  - *Findings.* A reachable file that does not parse is a `compile-error` at its first error's file,
    line and column. A reachable file's static import (`import … from`, `export … from`; not
    `import()` or `require()`, which an app may guard) of a package is an `undeclared-import`, at the
    import's line, unless: a package.json from the file's directory up declares it (all four
    dependency fields), it is a workspace package, a lockfile lists it as installed where the file
    can import it (`node_modules/<name>` at the root or the file's workspace in package-lock.json,
    any package in yarn.lock, pnpm-lock.yaml (lockfile v5's `/name/1.0.0` keys too) or bun.lock: npm
    hoists what dependencies need, ADR 0004's phantom dependencies), an import map or the build tools' configs name it (a quoted name or
    a key in `vite.config.ts`), or it is not a package: a Node built-in, a relative or absolute path,
    a scheme (`node:`, `virtual:`, `astro:`, URLs), an alias above, a `baseUrl` directory
    (`components/…`), or an asset (`.css` and other non-script extensions, a `?raw` query: `uno.css`,
    `@unocss/reset/tailwind.css`). TypeScript's elided imports (types, and imports nothing uses) do
    not count. Next.js's `server-only`, `client-only` and `styled-jsx` are provided by Next.js.
  - *Cost and containment.* The check runs in a child process (a worker thread's termination left
    the esbuild service it had started running, and each finished check left an unreaped esbuild
    process), in its own process group on POSIX, at a lower priority, with a 1 GB JavaScript heap and
    `GOMEMLIMIT=1GiB` for esbuild, and its stderr dropped (esbuild's crash reports do not reach the
    host's). `GOMEMLIMIT` is a soft limit: Go's collector works harder near it but does not stop
    there (the review saw esbuild at 1.2 GB on crafted input); the hard bounds are the input caps,
    the nesting limit and the time budget. It has a 10 s budget: then, and after every check, its process group (Windows: its
    process tree, `taskkill /T`) is killed, esbuild's service with it, and nothing is found; it
    exits on its own a second later too. It stops esbuild and waits for it before it exits, so it
    reaps it. It reads only the files it is sent, each size-capped in UTF-8 bytes on the host's
    thread (a file that cannot fit what is left of the total is skipped by its length, unmeasured)
    and sent one at a time: source, page, config and manifest files 512 KB each, lockfiles
    16 MB, 2,000 source files and 24 MB in all. Its scans are linear, and a component's scripts are
    at most 16. A check that fails emits one process warning. `src/source-check.ts` is one of the
    files allowed to start processes (`.oxlintrc.json`); it starts Node on its own module, which runs
    no project code: esbuild only parses it.
  - *What bears on the app.* Of what the check found, only what the running app touched counts
    (`relevantFindings`): a finding in a file the app's processes have read, and an undeclared import
    only of a package that is not installed where its file imports it from. The runtime records the
    project files its processes read (`Vfs.trackReads`: the main runtime's file system, which its
    threads' and child processes' reads reach) and answers whether `node_modules/<name>/package.json`
    is there from the file's directory up (`installedFrom`), through a host call (`projectReads`);
    without an answer within 3 s, or from a runtime that does not record reads, nothing counts. A
    file only another route imports was not read: a slow page that streams has read no broken file.
    A package npm installed anyway (Nuxt's `h3` and `vue-router`, a Next app's
    `@tanstack/query-core`, as dependencies' dependencies, with no lockfile in the project) resolves,
    as it does under npm. Reading is not running (a scanner reads files it never runs), so this only
    says which finding to name, never that the app has failed.
  - *It never ends the ready phase.* The sources are checked once the ready phase has run 20 s
    without the app rendering (a run whose app renders sooner never checks them), and what bears on
    the app is matched again every 2 s until the phase is over, so that it is there when the
    deadline comes. The phase ends as it would without the check: the app renders, it fails on
    its own error, or it times out.
  - *Classification.* A ready phase that timed out with something found that bears on the app is
    `app-bug` with the finding's rule (`compile-error` or `undeclared-import`) and message
    (`<file:line:column>: <message>`, `imports undeclared package "<name>" (<file:line>)`). Its first
    evidence says what happened in plain words: "ready timed out; the app read lib/render.js, which
    does not parse: lib/render.js:1:23: Unexpected ";"", or "…, which imports "dayjs", a package it
    neither declares nor has installed (…)". Only a timeout is labelled so: a ready phase that failed
    on an error of its own (the app threw, its page answered 500, a console error) keeps its class
    and rule, even `unknown: unmatched`, as a file a scanner read is not its cause; the finding is
    added to its evidence ("the app also read lib/x.js, which does not parse: …"). Nor is a timeout
    labelled when Sandburg's side or the runtime says why: an infra error or a broken download (in
    the phase's error, the runtime's errors or its output), a runtime signature (a built-in it
    lacks), a WebAssembly trap in its output, or a probe that found the project unsupported. The
    rules that read the dev server's own report come first. The check is stopped (its process
    group killed) as soon as the phase is over, when it has not finished by then.

The source check first failed the ready phase early (at about 20 s) when it found something. Three
reviews found healthy apps it failed, each time with a different signal for "the page hangs":

- **"No output for 10 s, and the page's document answered 2xx and has not ended."** A server
  render that streams the page's start and waits 28 s for its data looks the same (`<body>`, then
  nothing), and so does `next dev` compiling a page (one "Compiling / ..." line, then nothing).
- **Network progress** (the page's body bytes): a slow server render sends nothing either until its
  data comes, exactly as SolidStart sends nothing after the page's head.
- **"The app read the broken file"** (`Vfs.trackReads`): reading is not running. Tailwind's content
  scan, a dependency optimizer's crawl and any `fs.readFileSync` over a directory read files they
  never run, so a broken file a lazy route imports fails a healthy page whose data is slow.

No signal the run can observe separates a page that hangs forever from one that is slow, before the
deadline. So the check classifies; it does not decide. The cost: SolidStart's silent hangs (148, 203)
take the whole ready deadline (240 s), as before this change, and now end as `compile-error` or
`undeclared-import` with the file and line instead of `timeout`. The worst case of a wrong finding
is a genuine timeout labelled with a source file the app read, and the evidence says so.

## Results

- **148 and 203** (`corpus/`, run with their checks, the node runtime and Chromium 153, the ready
  deadline 240 s; cold is an empty working directory, so empty Sandburg stores, npm's own cache warm):

  | App | Before (v7 study) | Now, cold | Now, warm |
  |---|---|---|---|
  | 148 (syntax) | `timeout` after 242 s | `compile-error` `src/components/ConverterFeature.tsx:3:16: Unexpected ";"`, 248.3 s (ready timed out at 240 s) | the same, 241.2 s (ready timed out at 240 s) |
  | 203 (undeclared import) | `timeout` after 242 s | `undeclared-import` `imports undeclared package "dayjs" (src/components/CounterFeature.tsx:3)`, 249.7 s (ready timed out at 240 s) | the same, 243.2 s (ready timed out at 240 s) |

  SolidStart's server render reads the broken component, and dayjs is not installed: both bear on
  the app. With the early fail (before this decision) they ended at about 20 s of ready.

- **Slow, healthy apps are never failed** (`test/e2e/run.test.ts`), each with a broken file a route
  the run never asks for imports: a server that says it is compiling once and answers its page
  after 28 s, one that sends 200 and `<body>` at once and the rest after 28 s, and two of those
  whose server first reads every file of `lib/` as text (as Tailwind's content scan does), one with
  an undeclared import there and one with a syntax error. All pass their ready phase at about 28 s,
  as on main.
- **A page that hangs on a file its server read** (the same test file): a server that answers 200,
  streams the page's start, imports a module that does not parse (the error swallowed) and never
  ends the page times out at its (shortened, 30 s) deadline, classified `compile-error`
  `lib/render.js:1:23: Unexpected ";"` with "ready timed out; the app read lib/render.js, which does
  not parse: …". One whose own file imports `ms` without declaring it, while declaring `debug`, which
  npm installs `ms` for, is a plain `timeout` (`phase-deadline`): without the installed check it was
  classified `undeclared-import "ms"`.
- **No false positives on the corpus.** Over all 232 corpus apps, the check flags exactly the 29
  seeded faults, each at the line the generator seeded: the 15 syntax errors (`const broken = ;`, in
  `.ts`, `.tsx`, `.js`, `.vue` and `.svelte` files) and the 14 undeclared imports (v6's `nanoid`, v7's
  `dayjs`), and nothing in the other 203 apps (`test/unit/corpus.test.ts`, which reads each app's
  fault from its meta.json). The repo's 20 fixtures have no findings either.
- **Real repositories.** Shallow clones of vercel/commerce, antfu/vitesse, elk-zone/elk,
  nuxt/movies, gothinkster/angular-realworld-example-app, solidjs/solid-start and
  nestjs/typescript-starter have no findings (each 9–201 ms), with their lockfiles; without them, elk's
  `vue-router` and `h3` are flagged by the check, and a run drops them as installed. With a syntax
  error put into each of
  26 of their source files in turn, 20 are reported at that file; the 6 not reported are files only
  a build plugin reaches (vitesse's `import.meta.glob`'d modules, its auto-imported components,
  layouts and stores) and a fixture of the solid-start repository's own monorepo, which is not the
  app. Their patterns are unit tests (`test/unit/source-check.test.ts`): `baseUrl` imports, a
  virtual stylesheet, Vue's and Svelte's generics, Astro's expressions and self-closing scripts,
  legacy decorators, hoisted packages in each lockfile format, a peer of a workspace package, test
  setup files, a classic script's `with`.
- **Cost and containment.** A corpus app takes a median of 6.8 ms (95th percentile 13 ms, at most
  23 ms) on the check's thread. A 508 KB `.vue` file of 65,000 unclosed `<script>` tags takes 258 ms
  (before: about 11 s, synchronously, on the host's main thread), and an 898 KB page of 39,000
  import-map tags 8 ms when read (before: 13.3 s); over the 512 KB cap it is not read at all. A
  check of 64 files of about 500 KB (the 24 MB cap reached) takes about 0.7 s in its process, while
  the host's event loop is delayed at most 9 ms (before, at the 64 MB cap: 260–740 ms); one of
  2,000 files of 500 KB, at most 7–31 ms (99th percentile at most 13 ms; before measuring only
  what fits, 220–280 ms). After ten
  checks no esbuild process is left, unreaped or running; after checks killed at their budget (150,
  300 and 450 ms into half a second of work) none is left running, on Linux and on Windows (CI). A
  stand-in esbuild that ignores hangups, terminations and the end of its input is gone after the
  budget's kill of the check's process group (POSIX; killing the check's process alone leaves it). 500
  KB of nested `[` or `{` is skipped at once, where esbuild's service crashed.
- **Healthy runs are not slower.** `scripts/bench.ts` (origin/main against this change, 3 rounds,
  medians, a 4-vCPU machine): vite-react-counter 5.57 s → 5.43 s cold, 1.49 s → 1.54 s warm;
  lit-vite 4.86 s → 4.66 s cold, 1.23 s → 1.25 s warm; next-app-router 21.19 s → 20.57 s cold,
  4.12 s → 4.18 s warm: within the runs' noise (their ready phases within 2%). None of these apps'
  ready phases reaches 20 s, so their sources are never checked; what every run does is record the
  project files its runtime reads (a set of paths).
- **The POST after a cold start** (`test/e2e/run.test.ts`): a server that answers its page's first
  load 500, then a blank page whose script posts to its own URL and gets 500, fails the ready
  phase in 17 s with that console error. Before: the 60 s deadline.

## Consequences

- An app whose page hangs with no output on a syntax error or an undeclared import still takes the
  ready deadline, as before, and now ends as `compile-error` or `undeclared-import` with the file
  and line the app read, instead of `timeout`. Healthy apps, however slow, are never failed by it.
- A page that hangs for another reason (a server render that waits on a backend that never
  answers), whose app read a broken file, times out labelled with that file: the evidence says the
  phase timed out and what the app read.
- The check misses what it cannot follow: files a build plugin imports (`import.meta.glob`,
  auto-imported components outside Nuxt), dynamic `import()` and `require()` of packages, and files
  past its caps. A missed fault leaves the run as it was before this change (a timeout).
- A page whose own 5xx documents and requests to its own URL interleave is judged by count, not by
  which request Chromium's entry is about; Chromium's entry does not say.
