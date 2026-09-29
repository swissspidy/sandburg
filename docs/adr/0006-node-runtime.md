# ADR 0006: Sandburg's own Node.js runtime for the browser

- Status: Accepted
- Date: 2026-09-29

## Context

Sandburg must run real Next.js apps. The runtimes we tried fall short:

- **almostnode** (ADR 0003) runs Next.js through its own reimplementation of
  the dev server. It loads dependencies from esm.sh and has no webpack, SWC,
  PostCSS or Next.js plugins. The fidelity study (ADR 0004) shows where the
  two disagree.
- **Nodebox** emulates Node.js 16, so current Next.js does not start. Its
  license is not open source.
- **WebContainers** would work, but it is commercial, so it is out.

Next.js needs a Node.js that is close to the real one. It runs its own dev
server, webpack, SWC and React Server Components, and it relies on
`AsyncLocalStorage`, `vm`, `require` hooks and the full `fs` and `http`
surfaces. So Sandburg now has its own runtime. It targets Node.js 24
(`process.version` is `v24.11.0`) and runs real, unmodified packages from
npm.

## Decision 1: Node.js in a Web Worker, with a host-side install

- **Where it runs.** The runtime (`src/node-runtime/`) is one bundle,
  `/__sandburg/node-worker.js`, running in a dedicated Web Worker on the
  sandbox origin. Built-ins that browsers can supply come from polyfills,
  bundled with esbuild: `readable-stream`, `path-browserify`,
  `crypto-browserify`, `browserify-zlib`, `buffer` and `events`. Sandburg
  implements the rest itself:
  - `fs` and `fs/promises`, including streams, `writev` and watchers,
  - `http` and `https` servers,
  - `process`, `module`, `vm`, `async_hooks`, `worker_threads` (stubs), `os`,
    `net` and `diagnostics_channel`.
- **Module loader.** The loader (`loader.ts`) reimplements CommonJS as Node
  does. It keeps `Module._load`, `_resolveFilename`, `_extensions`, `_cache`,
  and the `exports` and `imports` fields, with conditions `require`, `node`,
  `module-sync` and `default`. Frameworks patch these hooks (Next.js aliases
  `react` through `_resolveFilename`), so they must behave like Node's.
  ES modules and TypeScript are compiled to CommonJS before they run
  (decision 2).
- **Dependencies.** The host runs `npm install --ignore-scripts
  --omit=optional` once per dependency set and caches the result in
  `.sandburg/installs/<key>`. The key hashes the lockfile, or
  `package.json` if there is none. The worker gets an index of the tree.
  Files are fetched lazily with synchronous XHR from
  `/__sandburg/nm/<key>/…` the first time they are read, because
  `require` and `readFileSync` are synchronous. A cached install makes the
  install phase about 1 s.
- **SWC.** Native SWC binaries cannot run in a browser. The installer puts
  `@next/swc-wasm-nodejs` where Next.js looks for it, and the runtime sets
  `NEXT_TEST_WASM=1`.
- **Starting.** A Next.js project starts the way a custom server does:
  `next({ dev: true, webpack: true })` plus `http.createServer`. This is
  single-process `next dev`, without Turbopack, which needs native code. Any
  other project starts from `node <file>` in its `dev` or `start` script, or
  from `main`.

## Decision 2: The host compiles, the browser runs

The worker posts code to `/__sandburg/compile`, where native esbuild
converts it (`src/adapters/node/compile.ts`). esbuild only transforms the
code; the host never runs it. Results are cached by content hash.

- ESM → CommonJS, and TypeScript → JavaScript (Node 24 strips types).
- `async`/`await`, async generators, `for await` and `import()` are lowered.
  This keeps `AsyncLocalStorage` context across `await` (decision 3), and it
  makes `import()` go through the loader.
- Next.js dev bundles use webpack's `eval-source-map`, so module code sits
  inside `eval("…")` strings. Those strings are decoded, lowered and
  re-encoded in place. They stay direct evals, with the same scope.

The host already runs esbuild natively, so esbuild-wasm is not needed here.
It is a candidate for a static-build adapter that compiles in the browser.

## Decision 3: AsyncLocalStorage without async_hooks

Browsers do not expose the promise hooks that `AsyncLocalStorage` needs.
Native `await` resumes without them, so it cannot carry context. Once async
functions are lowered to generators and `.then`, the runtime can carry the
context itself (`async-context.ts`). It captures the context in
`Promise.prototype.then`, `queueMicrotask` and timers, and
restores it when they call back. React Server Components and Next.js request
storage depend on this.

## Decision 4: Virtual HTTP servers behind a service worker

`http.createServer().listen(port)` registers a virtual server in the
worker. The sandbox origin's service worker (`sw.js`) forwards every app
request to the host page through a `MessagePort`. The host page passes it to
the worker, and the response streams back in chunks. Details:

- **Cookies.** The host page sends `document.cookie` and applies
  `Set-Cookie` itself, because a service worker cannot. It cannot honor
  `HttpOnly`.
- **Compression.** `Accept-Encoding` is removed from requests. Browsers do
  not decode compressed bodies in responses a service worker builds.
- **Outbound traffic.** `fetch` and `https.request` go through the browser
  and the egress gateway. They follow the same allowlist as other runtimes.

## Consequences

- A real Next.js 15.5 app (App Router, client components, a route handler)
  passes all its checks: `test/e2e/node.test.ts`. Timings: install about 1 s
  when cached, start about 7 s, and about 17 s until the first page compiles
  and renders. Routes compile on first request, as in `next dev`. So the
  adapter sets the `expect` timeout in checks to 20 s (a new `timeouts.expect`
  setting; the default stays 5 s).
- An Express server passes in under 5 s.
- The runtime is about 3,500 lines. It grows when an app needs a Node.js API
  that nothing covers yet. A missing API throws a clear "not supported"
  error, and the run is classified from that error.
- Not supported yet:
  - WebSockets, so there is no HMR (the `/_next/webpack-hmr` socket gets a 404
    and Next.js carries on),
  - child processes and worker threads,
  - native addons, `net` sockets, and Turbopack,
  - Vite, whose dev server depends on esbuild and Rollup native binaries.
    almostnode stays the default for Vite.
- The runtime is single-threaded and compiles webpack bundles in the
  browser, so it is slower than native. That is acceptable for testing. The
  Docker reference is still the ground truth (ADR 0004).
