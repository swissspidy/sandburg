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
  "Failed to load resource: … 5xx" entry for URL X is the page's load only while the number of such
  entries for X so far, that one included, is no more than the number of the app frame's 5xx
  documents for X. A later one is the app's own request failing, and fails the phase after the
  console-error grace period (8 s). An app error seen while the page's server error waits to be
  checked again is kept: if the page has recovered at that check, the app error's own deadline
  applies (the run above fails 8 s after the POST's error, not 8 s after the recheck).
- **An `Error` or `Exception` token right after `/` or `\` is a path, not a thrown error.** `Error:
  x`, `Uncaught (in promise) TypeError: …`, `[nuxt] error caught during app initialization
  TypeError: …`, `DOMException: …`, `ERROR TypeError: …` and a namespaced
  `Prisma.PrismaClientKnownRequestError: …` still count; React's warnings are still left out.
- **The project's sources are checked when the ready phase stalls** (`source-check.ts`,
  `failOnSourceStall` in `orchestrator/app-ready.ts`), in a way that does not depend on the
  framework:
  - *What is checked.* The project's own JavaScript and TypeScript modules and the scripts of its
    components (Vue's and Svelte's `<script>` blocks, Astro's frontmatter and its processed
    `<script>`s), each a module of its own, blanked around so lines and columns are the file's. Not
    `node_modules`, dot directories (`.nuxt`, `.svelte-kit`, …), `dist`, `build`, `out`,
    `coverage`, `public`, `static`, tests (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `e2e/`, …),
    stories or `.d.ts` files. One esbuild build (the native esbuild Sandburg already uses on the
    host) parses them all, with every import external and nothing written. A file that does not
    parse is a `compile-error` at its first error's file, line and column. Each static import
    (`import … from`, `export … from`; not `import()` or `require()`, which an app may guard) of a
    package the file's project does not declare is an `undeclared-import`, at the import's line.
    TypeScript's elided imports (types, and imports nothing uses) do not count, as they never reach
    the dev server. Astro's frontmatter may `return`, which no module may: each top-level `return`
    esbuild reports is rewritten to `if(1) `, of the same length, and the frontmatter parsed again.
  - *What is declared.* The dependencies (all four fields) of each package.json from the file's
    directory up to the project's root, the workspace packages' names, an import map's names (a
    static app's `<script type="importmap">`), tsconfig.json `paths`, names quoted in the build
    tools' configs (aliases in `vite.config.ts`), Node's built-ins, and what is not a package name:
    relative and absolute paths, schemes (`node:`, `virtual:`, `astro:`, URLs), `#…`, `~…`, `$…`
    and `@/…` aliases. Next.js's `server-only`, `client-only` and `styled-jsx` are provided by Next.js.
  - *When.* Only once the ready phase has run 20 s without the app rendering: a run whose app
    renders sooner never checks its sources. What is found fails the phase once the dev server
    (the runtime's output) and the page (its errors) have also said nothing for 10 s, with
    "app did not render, and its sources have an error: <file:line:column: message>" or
    "…: imports undeclared package "<name>" (<file:line>)". A dev server still at work, and an error
    in the page (the app-error watch's to judge, 8 s), keep it waiting.
  - *Classification.* A ready phase that failed that way, or timed out after the check found
    something, is `app-bug` with the finding's rule (`compile-error` or `undeclared-import`) and
    `<file:line:column>: <message>` or `imports undeclared package "<name>" (<file:line>)`. Other
    rules that read the dev server's own report come first.

## Results

- **148 and 203** (`corpus/`, run with their checks, the node runtime and Chromium 153; cold is an
  empty working directory, so empty Sandburg stores, npm's own cache warm):

  | App | Before (v7 study) | Now, cold | Now, warm |
  |---|---|---|---|
  | 148 (syntax) | `timeout` after 242 s | `compile-error` `src/components/ConverterFeature.tsx:3:16: Unexpected ";"`, 30.5 s (ready 20.3 s) | the same, 21.8 s (ready 20.3 s) |
  | 203 (undeclared import) | `timeout` after 242 s | `undeclared-import` `imports undeclared package "dayjs" (src/components/CounterFeature.tsx:3)`, 26.8 s (ready 20.3 s) | the same, 22.0 s (ready 20.4 s) |

- **No false positives on the corpus.** Over all 232 corpus apps' sources, the check flags exactly
  the 29 seeded faults, each at its seeded line: the 15 syntax errors (`const broken = ;`, in
  `.ts`, `.tsx`, `.js`, `.vue` and `.svelte` files) and the 14 undeclared imports (v6's `nanoid`, v7's
  `dayjs`), and nothing in the other 203 apps. A unit test keeps it so
  (`test/unit/corpus.test.ts`). The repo's 20 fixtures have no findings either. The check takes a
  median of 5.5 ms per corpus app (95th percentile 12 ms, at most 25 ms) on a 4-vCPU machine.
- **Healthy runs are not slower.** See the benchmark below.
- **The POST after a cold start** (`test/e2e/run.test.ts`): a server that answers its page's first
  load 500, then a blank page whose script posts to its own URL and gets 500, fails the ready
  phase in 17 s with that console error. Before: the 60 s deadline.

## Consequences

- An app that hangs with no output on a syntax error or an undeclared import fails in about 20 s of
  ready, with the file and line, whatever its framework.
- An app whose ready phase takes more than 20 s and goes quiet for 10 s, and whose sources have a
  file that does not parse or an import its project does not declare, fails as that app bug even if
  it would have rendered later: a broken file the app never imports, or a package npm hoisted from
  another dependency (a phantom dependency, ADR 0004), which resolves. Healthy apps render well
  within 20 s; the corpus has no such file, and its hoisted `nanoid` apps (054, 078, 084) render
  first.
- Imports the check cannot see are not reported: dynamic `import()`, `require()`, and template-only
  imports of a Vue `<script setup lang="ts">` (TypeScript elides them).
- A page whose own 5xx documents and requests to its own URL interleave is judged by count, not by
  which request Chromium's entry is about; Chromium's entry does not say.
