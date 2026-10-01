# ADR 0020: With a browser install, the page compiles too

- Status: Accepted
- Date: 2026-10-01

## Context

The opt-in browser install ([ADR 0018](0018-browser-install.md)) takes npm off the host, but the
runtime still asked the host to compile modules: ES modules to CommonJS, TypeScript, async lowering
(`/__sandburg/compile`, native esbuild) and the top-level await scan (`/__sandburg/tla-scan`). For a
run that needs nothing from its host but static files, the page has to do that too.

The runtime's module loader is synchronous, as `require()` is, so a compile must answer
synchronously. esbuild's WebAssembly build has only an asynchronous API in a browser. The compiler
(`compile.ts`) already yields each esbuild transform it needs, so the same code runs synchronously
on native esbuild and asynchronously on the WebAssembly build. The demo site uses that in its
service worker ([ADR 0015](0015-static-demos.md)).

## Decision

**A compile broker in the page** ([`compile-worker.ts`](../../src/adapters/node/compile-worker.ts)).
The page starts it as the browser install starts, so esbuild's WebAssembly loads while the packages
download. It spreads compiles over up to four compile workers, each with its own esbuild, and keeps
the results by content: a runtime's threads load the same files.

**Runtimes wait on shared memory.** Each runtime has a port to the broker and a mailbox (a
`SharedArrayBuffer`). It posts a compile with its mailbox and blocks in `Atomics.wait` until the
broker writes the answer and notifies it. A thread or child process gets its own port from its
parent. The runtime posts through the browser's own `postMessage`, not the `worker_threads` emulation
that numbers its messages. An answer too big for the mailbox comes back as its size, and the runtime
asks again with a mailbox that size; the broker kept the answer.

**The host serves static files only**: the page, the runtime and compiler bundles, and esbuild's and
SQLite's WebAssembly. A test checks that a browser-install run sends no compile or scan to the host.

## What it took

Server-rendering fixtures (React Router, Astro, Nuxt, SolidStart) hung in the first try. The cause
was not the compiler. A runtime starts a worker per thread and child process, and napi-rs
WebAssembly threads (rolldown) start dozens of them, often while their parent is blocked. The
browser reads a worker's script only as the worker loads. Each worker downloaded the runtime bundle
(several MB, `no-store`), and the downloads of blocked workers held all six connections to the host.
The app's own `ws-shim.js` waited behind them, so its HTML never finished parsing. Compiling in the
page changed the timing enough to expose this. The service worker now downloads the runtime script
once per run and answers every worker from memory.

## Results

All 17 fixtures pass with `--install-in browser`, compiled in the page, with nothing compiled on the
host. Warm HTTP cache; the host-compile column is from ADR 0018:

| Fixture | Start, host compiles | Start, page compiles | Total, page compiles |
|---|---|---|---|
| angular-tasks | 18.0 s | 22.8 s | 34.0 s |
| angular-zone | 21.7 s | 22.5 s | 36.6 s |
| astro-app | 20.1 s | 16.9 s | 30.3 s |
| lit-vite | 4.4 s | 6.0 s | 10.4 s |
| next-app-router | 8.2 s | 11.6 s | 30.5 s |
| node-express | 0.7 s | 0.8 s | 3.5 s |
| nuxt-app | 5.8 s | 8.5 s | 37.0 s |
| preact-vite | 5.2 s | 7.7 s | 12.8 s |
| react-express-split | 8.9 s | 10.2 s | 17.1 s |
| react-router-app | 11.4 s | 12.0 s | 19.7 s |
| solid-start-app | 6.7 s | 7.9 s | 23.2 s |
| solid-vite | 5.8 s | 6.9 s | 11.6 s |
| svelte-vite | 12.4 s | 12.4 s | 16.3 s |
| sveltekit-app | 15.6 s | 18.4 s | 26.3 s |
| vite-react-counter | 4.7 s | 6.4 s | 11.1 s |
| vite-socketio-chat | 8.2 s | 10.1 s | 14.2 s |
| vue-express-sqlite | 9.5 s | 11.8 s | 16.9 s |

Most stacks start in the same time or up to a few seconds later. The compile workers spread the
work, and threads and child processes reuse what the first runtime compiled.

One more race showed up under the extra CPU load. A child process ends when nothing keeps it busy for
200 ms, and in a project with SQLite it first loads SQLite's WebAssembly, which was not counted as
work. A load slower than 200 ms ended `vue-express-sqlite`'s dev script before it started (1 run
in 5). The load now counts as pending work.

## Consequences

- With `--install-in browser`, a run needs only static files from its host. The same page could be
  served from any static host or a CDN.
- Starting takes up to a few seconds longer than with host compiles: esbuild's WebAssembly build is
  about 6× slower than native, and each run compiles from scratch (each run has its own origin, so no
  browser cache carries over). A long-lived page that runs many apps on one origin could keep
  compiled modules in its own storage.
- Host installs are unchanged: they still compile on the host, where results are cached across runs.
