# ADR 0066: What fidelity study v7 found: shadow roots, Solid's hydration, fail-fast and classification

- Status: Accepted
- Date: 2026-10-28

## Context

Fidelity study v7 (232 generated apps in 14 frameworks, `docs/fidelity/v7-node-vs-truth.md`) got 224
apps right cold and 226 warm. All 93 seeded faults were caught. Its 8 false alarms, and its slow or
`unknown` diagnoses, came from these causes:

- **Lit, 6 apps (130, 141, 152, 185, 218, 229).** The ready phase counts an app as rendered when
  `#root`, `#app` or `#__next` has content, else when `document.body.innerText` has text. A Lit app
  whose root element renders only into its shadow root has none: innerText leaves shadow roots out.
  Every such run waited out the 240 s ready deadline. The Lit apps with logic bugs (174, 196) were
  "caught" only by the same timeout.
- **SolidStart, 214 (cold).** The first check filled a server-rendered input before Solid hydrated
  it, and the value never reached the app. Settling (`host/settle.ts`) took Solid's `_$HY` to mean
  "safe at once", since Solid records events until it hydrates and replays them. It does record
  them, but replaying one reaches no handler: Solid's delegated handler walks `composedPath()`,
  which is empty for an event that has finished dispatching (solid-js 1.9.17, `web/dist/dev.js`).
  `_$HY.done` means "Solid has handled an event", not "hydrated": Solid sets it when it handles
  its first event once hydration has begun (its `registry` exists), which can be a click on an
  element it has claimed while a lazy route's are not claimed yet; SolidStart also sets it when the
  URL changed before hydration. It stays unset after a hydration no event followed.
- **Angular, 134 (cold).** Vite's dependency optimizer, inside Angular's dev server, failed with a
  WebAssembly trap in rolldown (`Error during dependency optimization … memory access out of
  bounds`). The page's request was never answered. The ready phase waited for the frame's load event
  before it watched for errors, so the error it reported went unseen until the deadline.
- **Nuxt, 157, 190, 212 (syntax error, undeclared import, render crash).** `nuxt dev` answers 503
  with its loading page, then 500 for a page it cannot render. That error page sends
  `X-Frame-Options: deny`, so the app frame shows the browser's error page, which the ready phase
  reloads until its deadline. The fail-fast watch ignored the 500's console error, because the same
  URL had answered 503 before (the loading page). It ignored every error after that too, because
  they come from `chrome-error:`.
- **Crash faults classed `unknown: unmatched`, 103 (Astro), 137 (SolidStart), 222 (Angular).** Astro
  answers a server render's error with a 500 page and logs the error with a stack through
  `/app/src/pages/index.astro`. SolidStart logs it in the page, and Angular's ErrorHandler logs what
  the app threw with `console.error` instead of throwing it. Only page errors were checked for a
  stack through the project's files, and only `file:///app/` and served URLs counted as the
  project's.
- **SolidStart, 148 and 203 (syntax error, undeclared import).** These time out on a page that never
  finishes loading. Under real npm (`npm install`, `vite dev` and Chromium, outside Sandburg)
  SolidStart 2.1.0 does the same: it starts streaming the page, never ends it, and logs nothing on
  the server or in the page. There is no error for Sandburg to report.

## Decision

- **Rendered includes open shadow roots** (`host/rendered.ts`, used by both `waitForRender` and the
  host page's `rendered`). After the document checks, which are unchanged, text in an open shadow
  root at any depth counts if it is shown, as `innerText` would count it
  (`checkVisibility({ visibilityProperty: true })` of its element, or of the shadow root's host for
  text right in the root, as Lit renders): not under `display: none`, `hidden` or
  `visibility: hidden`, nor inside a style. An element with no shadow root, an empty one, or one
  with only styles and slots does not count. Neither do a dev server's overlays, by their exact
  names (`vite-error-overlay`, `vite-plugin-checker-error-overlay`, `astro-dev-toolbar`,
  `astro-dev-overlay`, `nextjs-portal`; an app's own `<vite-app>` or `<app-toolbar>` is looked in):
  without that exclusion, Astro's error overlay made a crashed page "rendered". At most 2,000 elements are looked at, across the document
  and its shadow roots, with tree walkers that stop there (a blank page of 100,000 elements is not
  listed whole). Closed shadow roots cannot be read; such an app can pass `--ready`.
- **Solid is hydrated when every server-rendered element (`[data-hk]`, all of them in the body) is
  in `_$HY.completed`**, which Solid fills as it claims each element. `done` does not count (above).
  Once `done`, Solid drops `completed` after replaying its recorded events, without looking at
  what is still unclaimed, so the claims can no longer be read: Solid then says nothing, and the
  app's servers being quiet decides, as for frameworks that say nothing (a lazy route's chunk is a
  request). A lazy route's elements are claimed when its chunk has loaded, so a check waits for
  those too.
- **A framework that says it has not hydrated yet is waited for up to 10 s** (`SETTLE_HYDRATE_MAX_MS`)
  before the checks start. When the framework says nothing, the app's servers going quiet decides,
  with the 3 s limit as before. This applies to Solid, Nuxt and SvelteKit, which can say "not yet".
  The cost: a page whose framework never says "hydrated" (SvelteKit with `csr = false`, a Nuxt page
  whose Suspense never resolves, a Solid hydration mismatch that leaves elements unclaimed) waits
  up to 7 s more per `settled()` call: before the checks, and after each check that timed out and
  loaded the app again.
- **The ready phase is watched from the app's first load**, not from after its load event: an error
  the app reports while its page never finishes loading now fails the phase. The app's frame is
  taken before the app loads into it (the host page has it from the start), so a loading page is
  recognised from the first load too.
- **A console error counts as the loading page's only when it is about a 503.** Separately, the
  app's page answering a 5xx other than 503 fails the phase after 8 s, the console-error grace
  period, unless the app renders first, and only if the page still answers one then (a cold
  start's 500 followed by a 200 does not). The page is the app frame's latest document, not the
  host page's nor one of a frame the app embeds. The browser's own console error for that page's
  failed load ("Failed to load resource: … status of 500") is left to this rule, so its recheck
  applies. That holds even when the frame shows the browser's
  error page instead of an error page that refuses to be framed. The ready deadlines are unchanged.
- **Classification.** Rules still run in order, and the first match wins:
  - `app-error-before-ready` also counts a console error from the app that reports a thrown error
    (its first line names one, `<Name>Error:` or `<Name>Exception:`: `TypeError: …`, Angular's
    `ERROR TypeError: …`, `Uncaught (in promise) TypeError: …`, Nuxt's `[nuxt] error caught during
    app initialization TypeError: …`, `DOMException: …`; not a line starting `Warning:`, nor
    React's key warning without it) and carries a stack through the project's files (Angular's
    ErrorHandler, SolidStart). A bare `(/app/<path>)` stack frame now counts as the project's too.
    A frame is the project's only outside `node_modules` at any depth and outside generated code
    (`.next`, `.nuxt`, `.output`, `.svelte-kit`, `.angular`, `.astro`).
  - New rule `server-render-error` (`app-bug`), checked after `app-error-before-ready` for a ready
    phase that failed. It covers the dev server reporting the app's page could not be rendered on
    the server, in what it logged since the ready phase began: Nuxt's `[request error] [GET] <the
    app's page>` (the path the dev server's start gave, `/app` and `/app/` alike) followed by `✖ <Error> (500): <message>`, or an error line followed by a stack
    through the project's files (Astro). Nuxt's `SyntaxError` / `[VITE_ERROR]` there is a
    `compile-error`.
  - `signature:wasm-trap` (`runtime-unsupported`) also matches the failed phase's own message
    when that is the dev server's report (`dependency optimization`, `Build failed`: Vite reports
    its dependency optimizer's failure to the page) or no stack runs through the project. A trap in
    the app's own WebAssembly in the page (sql.js, with a stack through `src/db.ts`) stays the app's.

## Results

The 18 affected corpus apps (from the `fidelity-v7` branch), cold (empty Sandburg stores) and warm,
3 tabs at a time, on the same 4-vCPU machine as the study. Their run time, summed, fell from 3,453 s
cold and 3,191 s warm in the study to 723 s and 600 s (335 s and 268 s of wall time):

| App | Expected | v7 study, cold / warm | Now, cold / warm |
|---|---|---|---|
| 130, 141, 152, 185, 218, 229 (Lit) | pass | timeout after 241–243 s / same | **passed** in 2–5 s / 2 s |
| 174, 196 (Lit, logic bug) | fail | timeout after 241 s / same | failed, `blocking-check-failed`, 7–9 s / 7 s |
| 134 (Angular) | pass | timeout after 245 s / passed | error, `runtime-unsupported: signature:wasm-trap`, 34 s / passed |
| 214 (SolidStart) | pass | failed (converter check) / passed | **passed** / passed |
| 157 (Nuxt, syntax) | fail | timeout after 241 s / same | `compile-error`, 32 s / 14 s |
| 190 (Nuxt, undeclared import) | fail | `undeclared-import` after 241 s / same | `undeclared-import`, 35 s / 13 s |
| 212 (Nuxt, crash) | fail | timeout after 241 s / same | `server-render-error`, 14 s / 13 s |
| 103 (Astro, crash) | fail | `unknown: unmatched`, 34 s / 13 s | `server-render-error`, 39 s / 14 s |
| 137 (SolidStart, crash) | fail | `unknown: unmatched`, 13 s / 12 s | `app-error-before-ready`, 27 s / 13 s |
| 222 (Angular, crash) | fail | `unknown: unmatched`, 14 s / 15 s | `app-error-before-ready`, 14 s / 13 s |
| 148, 203 (SolidStart, syntax / undeclared import) | fail | timeout after 242 s / same | unchanged: SolidStart hangs (above) |

Cold, 134 is still wrong: the trap still happens; it is now reported in 34 s, as the runtime's
failure, instead of after 245 s.

## The rolldown trap is Sandburg's, and not yet fixed

Under Sandburg, 134 trapped in three of four cold batch runs. Run alone it passed three of three
cold runs, and alone with four CPU spinners it trapped in two of three, with 14 GB of memory free.
The same rolldown 1.2.8 WebAssembly build under Node 24, outside Sandburg (`NAPI_RS_FORCE_WASI=true
ng serve`, the page loaded in Chromium, the dependency cache removed each time), never trapped:

- 4 of 4 runs fine idle;
- 4 of 4 fine with four CPU spinners;
- 4 of 4 fine with four spinners and the binding's emnapi replaced by the `2.0.0-beta.2` that
  Sandburg's install aligns it to (`emnapiToAlign`; the binding was built against `2.0.0-alpha.4`).

So it is not memory limits, and not the emnapi alignment. The trap depends on timing under CPU
contention in what Sandburg puts under rolldown's threads: the thread runtimes, their file system
(`node-runtime/threads.ts`: the parent's VFS over a synchronous RPC, and the snapshot a thread
reads when its parent does not answer within 200 ms) and WASI on it. `readSync` keeps to the
length it is asked for. Finding the race is follow-up work. Until then, a run that hits it fails
fast as `runtime-unsupported` and can be run again.

## Consequences

- An app that renders only into shadow roots is ready as soon as it shows text there. One whose
  only text sits in a closed shadow root, or past the first 2,000 elements, needs `--ready`.
- SolidStart, Nuxt and SvelteKit apps that hydrate slowly start their checks up to 10 s after
  rendering instead of 3 s, and one whose framework never says "hydrated" waits up to 7 s more
  per settle. Apps whose framework says nothing are unaffected.
- Faults in server-rendered pages (Nuxt, Astro, SolidStart) and Angular's logged crashes are now
  classified by what the dev server or app reported, mostly within the console-error grace period
  instead of after the 240 s deadline.
