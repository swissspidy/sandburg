# ADR 0021: Generate an app in the browser, and run it there

- Status: Accepted
- Date: 2026-10-01

## Context

The browser install ([ADR 0018](0018-browser-install.md)) and compiling in the page
([ADR 0020](0020-compile-in-the-page.md)) mean a run needs only static files from its host. The
aim of that work was a page where a model generates an app and the page runs it, with no server.
The demo site on GitHub Pages ([ADR 0015](0015-static-demos.md)) is a static host that is
already deployed.

## Decision

**A generator page on the demo site** (`generate/`, [`pages/generate/`](../../pages/generate)). The
visitor picks a provider (Anthropic or Google), a model and a framework, and pastes an API key.
After they describe an app, the page:

1. **Asks the model** from a key vault (see below). Both APIs accept cross-origin requests, from an
   opaque origin too. Anthropic's API needs `anthropic-dangerous-direct-browser-access`, and
   Gemini's takes the key in `x-goog-api-key`. Answers stream as server-sent events over plain
   `fetch`, so there is no SDK to bundle and one code path covers both providers.
2. **Starts the model from a scaffold** for the chosen stack ([`templates.ts`](../../pages/generate/templates.ts)):
   React, Vue or Angular 22, SvelteKit, SolidStart 2, Next.js 16, Nuxt 4, Astro 7, or plain HTML,
   CSS and JavaScript. Each uses the versions the fixtures use, so the model does not have to guess
   versions or config. Every scaffold has a backend and a SQLite database. React, Vue, Angular and
   plain HTML get an Express API in `server/`, behind the dev server's proxy (Express serves the
   plain HTML too). The full-stack frameworks use their own server code: SvelteKit `load()`, Next.js
   server components and route handlers, Nuxt server routes, Astro frontmatter and endpoints,
   SolidStart `"use server"` functions. Every scaffold reaches the database through `node:sqlite`.
   It is built into Node.js, so no bundler has to treat a native package specially, and the runtime
   implements it on SQLite's WebAssembly build. The system prompt
   ([`prompt.ts`](../../pages/generate/prompt.ts)) says what runs in Sandburg's runtime and how to
   use the database.
3. **Reads files from the answer.** The model writes each file whole between
   `<file path="…">` and `</file>`, and deletes a file with `<delete path="…" />`
   ([`files.ts`](../../pages/generate/files.ts)). The format can be parsed while it streams, so the
   page shows each file as it is written. Paths outside the project, and paths in `node_modules`,
   are rejected.
4. **Runs the project as a Sandburg run does**: `mount`, `install`, `start` and `ready` through
   `window.__sandburg`. The page works out the install plan itself:
   [`plan.ts`](../../src/adapters/node/plan.ts) is the part of the node adapter that depends only
   on a project's files, moved out of `index.ts` so that a page can bundle it.
5. **Applies later requests to the running app.** Files are written into the runtime and the dev
   server reloads them (Vite's HMR, Next.js' Fast Refresh). Some changes need a new run in the same
   page: a change to `package.json` or a config file, an Express server's code, or a deleted file.
   Nuxt reloads its own `server/` code. A new run keeps the app's data: the page reads the SQLite
   files the app wrote from the runtime that is ending (`__sandburgReadFiles`) and mounts them into
   the next one. The
   conversation is append-only, and each Claude turn, thinking blocks included, is sent back exactly
   as the model wrote it. Each request then reads the earlier turns from the prompt cache.
6. **Feeds errors back to the model.** The page collects three kinds of error: the run failing,
   error lines on the dev server's stderr, and uncaught errors or `console.error` calls in the app's
   frame. "Fix errors" sends these to the model with the current files. Auto-fix does the same on
   its own, at most twice per request.

**The API key never reaches the page.** The generated app runs in a frame on the page's origin,
because that is how the service worker serves it. The app's code, and every npm package it
loads, can therefore do anything the page can: read its fields and storage, or wrap its `fetch` to
catch the next request's headers. Other sites on the same origin (`<user>.github.io`) can read its
storage too. A key anywhere on that origin is exposed. So the key lives in a vault
([`vault.ts`](../../pages/generate/vault.ts)). The vault is a sandboxed `srcdoc` frame without
`allow-same-origin`, which gives it an opaque origin. The page creates it before any generated code
runs. The vault holds the settings, the key field and the request field, and makes the calls. The
page sends it the conversation and gets the answers back by `postMessage`
([`protocol.ts`](../../pages/generate/protocol.ts)), and never gets the key.

- **Calls need a click in the vault.** The vault calls the model once per Generate or Fix click
  (the page must ask within 10 s). After a Generate click with auto-fix on, it also makes up to two
  error fixes. An app that takes over the page cannot spend the key on calls of its own. At most, it
  can trigger those two fixes, and it still never sees the key.
- **The key is not stored.** An opaque origin has no storage, so the visitor enters the key once
  per visit. Keys that earlier versions stored on the page's origin are deleted.
- **A restored app (after a reload of the tab) runs only when the visitor clicks.** Generated code
  then runs only after the vault is in place.
- **What remains:** after an app has run, it can remove the vault and draw a fake one that asks for
  the key. The vault tells the visitor they enter the key once per visit, and to reload if they are
  asked again.

The site serves the runtime's own files from `runtime/`: the runtime's worker, the compile
worker, esbuild's and SQLite's WebAssembly, and the WebSocket shim. `sw.js` answers them under any
page's `__sandburg/` path and keeps each in memory, as `sw-core.js` does for the runtime's worker.
Nothing else is recorded. `?scaffold=<framework>` runs a scaffold without a model, and
`scripts/pages/build.ts --verify` runs each scaffold that way with packages from the npm registry.

## What it took

- **Paths under a prefix.** The page started its compile worker from `/__sandburg/compile-worker.js`,
  and the compile worker fetched `/__sandburg/esbuild.wasm`. Both now resolve against the host
  base (`__sandburgBase`) and the worker's own URL. On Pages they live under `/sandburg/generate/`.
- **Several runs in one page.** The host page's abort controller is new for each mount. The
  service-worker bridge keeps a single message listener that hands requests to the current run.
- **The registry's 404 has no CORS header.** From a page, a package that does not exist looks the
  same as a failed request. The install guesses the `<package>-wasm32-wasi` name of napi-rs
  packages, and `@next/swc-wasm32-wasi` does not exist, so Next.js failed to install from the open
  web. A Sandburg run's gateway hid this. A guessed name that cannot be read now counts as absent.
  When a real dependency cannot be read, the error says it may not exist, because a model sometimes
  invents a package name and that error goes back to it.
- **Full reloads.** A dev server's full reload (Vite does one when `index.html` changes) reloads
  the address the app sees, `/`. That address is outside the service worker's scope, and the
  response there has no COEP header, so the cross-origin isolated page turns it into an error page.
  [`frame-guard.js`](../../pages/frame-guard.js) remembers the app's address, and when the frame
  loads a document that no service worker controls, or one it cannot read, it loads the app at that
  address again. The demos use it too.

- **Safari and iOS.** The page becomes cross-origin isolated through headers its service worker
  adds: `Cross-Origin-Embedder-Policy: credentialless`. WebKit (Safari, and every browser on iOS)
  does not support `credentialless`, so the page stayed non-isolated and could not start the
  runtime. In WebKit the service worker now sends `require-corp`; the browser is detected from its
  user agent. Under `require-corp`, cross-origin resources must opt in with CORS or CORP headers.
  Module scripts, `fetch` to the model APIs and the npm registry use CORS. A plain `<img>` from a
  site without those headers does not load. Every scaffold, two demos and a generation through the
  vault ran with `require-corp` in Chromium, using an iPhone user agent. WebKit itself was not
  available to test. If a page still is not isolated, it now says why: either the service worker did
  not handle the page (private window, blocked), or the browser refused isolation.

## Results

Each scaffold, run from the built site under `/sandburg/` with packages from the npm registry and
no model involved:

| Scaffold | Run |
|---|---|
| HTML, CSS & JavaScript (Express) | 5.4 s |
| Vue (+ Express) | 17.5 s |
| SvelteKit | 18.2 s |
| Next.js 16 | 21.1 s |
| React (+ Express) | 23.1 s |
| SolidStart 2 | 28.4 s |
| Astro 7 | 32.8 s |
| Angular 22 (+ Express) | 48.2 s |
| Nuxt 4 | 62.4 s |

Each scaffold shows the SQLite version it read through its backend, and the build checks that it
does. Claude Opus 5.5 then wrote a to-do app on each of the nine stacks, with tasks stored in SQLite
through the backend. A task added in the app was still listed after the app was loaded again with
its browser storage cleared, so it came from the database. None needed a fix. A follow-up that
changed the schema (a priority column) went into Nuxt live, and restarted the Express servers of
Angular and plain HTML. Their task survived the restart.

With Claude Opus 5.5, a to-do app with filters and due dates (React) took 44–55 s to write
(about 6k output tokens) and 12 s to install and start. A request for a theme toggle took 48–63 s
and went into the running app by HMR. A guestbook on Express and SQLite took 49 s to write, 17 s to
install (131 packages) and 13 s to start. To test the fix loop, a broken `App.jsx` was written into
a running scaffold: the page collected Vite's "Failed to resolve import" error and the browser's
error, and the model fixed both in 12 s. With Gemini 3.1 Pro (preview), the same to-do
app took 79 s to write (11k output tokens, thinking included), and the theme toggle took 53 s and
went in by HMR.

## Consequences

- The demo site is the product's showcase for its intended use: an app that a model generates and
  that runs in the visitor's browser. It needs only static hosting.
- The visitor pays for the model with their own key, and enters it once per visit in the vault.
  Neither the generated app nor the page can read a key entered there. A probe run from the app's
  frame checked this: it searched the page's DOM, fields, storage and state, tried to read the vault,
  and asked the vault for a call. It did not find the key, could not read the vault, and the call was
  refused. This does not cover a fake vault that an app draws in place of the real one: a key typed
  there goes to the app (see "What remains" above).
- Each run downloads its packages, so a run on another tab or origin cannot reuse them.
  Compiled modules are not kept between runs (ADR 0020).
- The generator does not run Playwright checks. The page has no Playwright. Errors reach the model
  from the dev server's output and the frame instead.
