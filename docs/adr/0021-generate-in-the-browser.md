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

1. **Asks the model** from the page. Both APIs accept cross-origin requests: Anthropic's needs
   `anthropic-dangerous-direct-browser-access`, and Gemini's takes the key in `x-goog-api-key`.
   Answers stream as server-sent events over plain `fetch`, so there is no SDK to bundle and one
   code path covers both providers. The key stays in the tab's session storage, or in local
   storage if the visitor ticks "remember", and goes to the provider only.
2. **Starts the model from a scaffold** for the chosen stack ([`templates.ts`](../../pages/generate/templates.ts)):
   React, Vue or Svelte on Vite, plain HTML, Vue + Express + SQLite, or Next.js. Each uses the
   versions the fixtures use, so the model does not have to guess versions or config. The system
   prompt ([`prompt.ts`](../../pages/generate/prompt.ts)) says what runs in Sandburg's runtime.
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
   page: a change to `package.json` or a config file, server code, or a deleted file. The
   conversation is append-only, and each Claude turn, thinking blocks included, is sent back exactly
   as the model wrote it. Each request then reads the earlier turns from the prompt cache.
6. **Feeds errors back to the model.** The page collects three kinds of error: the run failing,
   error lines on the dev server's stderr, and uncaught errors or `console.error` calls in the app's
   frame. "Fix errors" sends these to the model with the current files. Auto-fix does the same on
   its own, at most twice per request.

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

## Results

Each scaffold, run from the built site under `/sandburg/` with packages from the npm registry and
no model involved:

| Scaffold | Run |
|---|---|
| HTML, CSS & JavaScript | 0.6 s |
| Vue + Vite | 13.6 s |
| React + Vite | 14.6 s |
| Svelte + Vite | 19.0 s |
| Vue + Express + SQLite | 25.4 s |
| Next.js 16 | 28.0 s |

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
- The visitor pays for the model with their own key. The generated app runs in a same-origin frame
  (that is how the service worker serves it), so the app's code, and any npm package it loads, can
  read the key from the page and from storage. So can other sites on the same origin
  (`<user>.github.io`). The page says so, and suggests a key with a spending limit. The key is
  remembered across browser sessions only if the visitor asks. To isolate the key, the app would need
  an origin of its own, as a Sandburg run gives it.
- Each run downloads its packages, so a run on another tab or origin cannot reuse them.
  Compiled modules are not kept between runs (ADR 0020).
- The generator does not run Playwright checks. The page has no Playwright. Errors reach the model
  from the dev server's output and the frame instead.
