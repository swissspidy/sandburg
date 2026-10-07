# ADR 0012: Real Vite in the node runtime (SvelteKit, Astro, React Router, Nuxt)

- Status: Accepted
- Date: 2026-09-30

## Context

The esbuild adapter (ADRs 0007, 0011) rebuilds what Vite's plugins do for
client-only apps. Meta-frameworks go further: they server-render through
Vite's dev server and module runner, generate code, and run their own
servers. Re-implementing them is not realistic, so the question was whether
real Vite 8 can run inside the node runtime (ADR 0006).

The native parts that Vite 8 and these frameworks need in development have
WebAssembly builds: rolldown and its oxc tools, and Astro's compiler (napi-rs
`wasm32-wasi` builds), and also rollup and esbuild (Nitro). napi-rs's
WebAssembly builds run on WASI and WebAssembly threads, which need
`worker_threads`, `node:wasi` and shared memory. The frameworks' CLIs also
start child processes and talk over local sockets.

## Decision

Run the frameworks' own dev servers unchanged in the node runtime and fill in
the Node APIs they need.

**Threads and WASI**
- `worker_threads`: a `Worker` is another runtime instance in a nested Web
  Worker. Threads share the file system. A thread's file system calls run on
  its parent's VFS over a synchronous RPC (SharedArrayBuffer + `Atomics.wait`).
  Installed packages are read from the host directly, so a thread can start
  while its parent is blocked, as WebAssembly threads require. Messages are
  structured clones (shared memory, `WebAssembly.Module`, ports).
- A parent that does not answer within 200 ms is taken to be blocked, and the
  thread reads its snapshot of the project files instead. That snapshot
  answers only for the paths it covers: not for caches and build output
  (`node_modules/.vite`, `.cache`, `.nuxt`, …), which a parent that is only
  slow may have just written. There the thread waits. Under load, rolldown's
  threads were told that Vite's new `node_modules/.cache/vite/deps_temp_*`
  did not exist, the dependency build failed, and Nuxt closed the dev server.
- A WebAssembly trap in a thread (memory access out of bounds, a Rust panic)
  ends its process, as a segfault or an abort in a native build would. The
  module's shared memory and the threads waiting on it cannot recover: a
  crashed rolldown thread left Vite's dependency optimizer, and the app's
  page, waiting until the run's deadline. The run now fails at once, as
  `runtime-unsupported` (`signature:wasm-thread-crash`). A thread of the
  app's own process also reports the crash to the page directly (a
  `BroadcastChannel`): its parent may be blocked in `Atomics.wait` and never
  pass it on.
- `node:wasi` is `@napi-rs/wasm-runtime`'s WASI on the runtime's `fs`.
- The page is cross-origin isolated (COEP `credentialless`). The service
  worker adds COEP and CORP headers to the app's responses.

**Child processes.** `child_process.spawn`, `fork`, `exec` and `execFile`
can run `node`. The child is a nested runtime like a thread. It gets stdio
(`pipe`/`inherit`/`ignore`), IPC, exit codes, `--conditions`,
`--require`/`--import` and `NODE_OPTIONS`. It ends when its event loop is
idle, as in Node. React Router's CLI relaunches itself with
`--conditions=development`. Other programs (shells, npm, git) still fail with
`ENOSYS`.

**Local networking**
- HTTP servers can listen on socket paths. `http.request` to `localhost` or a
  `socketPath` goes straight to the virtual server, whether it is in this
  runtime or a nested one, instead of `fetch()`.
- `net` servers and connections are stream pairs, also between a thread or
  child and its parent. Nuxt proxies requests to Nitro's server in a worker
  thread. That server loads modules from Vite over a vite-node socket.
- HTTP servers bind as on a platform without `SO_REUSEPORT`. Port 0 gives
  a free port from 40000–60000, as `net` servers already did; it used to be
  3000 and up. A port another server of the runtime holds fails with
  `EADDRINUSE`, and `reusePort` fails with `ENOTSUP`. The page takes a
  server on a port 0 bind for the app only if nothing else listens within
  5 s. `@nuxt/cli` 4 (Nuxt 4.6) probes port sharing on port 0 servers
  before it starts, and the page took the probe for the app.
- App pages define esbuild's `__async`. A dev server that sends one of its
  functions to the page as source text sends the compiled form, which
  calls it (`@nuxt/cli` 4's loading screen). `BroadcastChannel` has
  `ref()` and `unref()`.

**Installs.** Each napi-rs package whose linux-x64 build is published gets its
`wasm32-wasi` build too, found by napi-rs naming. The WebAssembly build's own
dependencies are nested inside it, so a project's other emnapi versions
cannot shadow them. `rollup` 4 uses `@rollup/wasm-node`. `esbuild` uses
`esbuild-wasm`'s browser build, which runs in the calling thread and has an
asynchronous API only. Both keep the same version and the same API.

**ES modules in the CommonJS loader**
- ES modules resolve with `import` conditions.
- Module-declared `require` and `__dirname` are renamed.
- Packages with top-level await become async modules.
- esbuild's Node-mode default-import interop is skipped for converted ES
  modules.
- `(async function () {}).constructor` is a real `AsyncFunction` whose body
  is lowered too. Vite's SSR module runner evaluates modules with it.

**Smaller fixes**
- BigInt `fs` stats and `util.parseArgs`.
- `base64url` in `Buffer` and `crypto` digests.
- `net.Server` port probing.
- `path` no longer has an enumerable `default` (`@vercel/nft` copies its
  keys).
- The `ClientRequest` header API and its `'socket'` event (httpxy).

## Consequences

- Five fixtures pass with server rendering, hydration and client navigation:
  - `svelte-vite` on real Vite.
  - `sveltekit-app`, from `sv create`, with `load()` and a second route.
  - `astro-app`: Astro 7 with frontmatter data, a client script and an API
    endpoint.
  - `react-router-app`: React Router 8 framework mode, with a loader and an
    action posted from a form.
  - `nuxt-app`: Nuxt 4 with a Nitro server route loaded by `useFetch`.

  The last three are hand-written because their scaffolders fetch templates
  from GitHub.
- Run times, with installs cached:
  - Start (dev server ready) takes 5–25 s.
  - The first page load takes a few more seconds, because Vite serves
    hundreds of dev modules.

  Checks wait for hydration before clicking.
- These frameworks need `--runtime node`. The default runtime is unchanged.
- The same runtime work helps any Node program that uses threads, WASI, child
  `node` processes or local sockets.
- Limits:
  - Synchronous child processes (`execSync`, `spawnSync`) are unavailable,
    because the parent would have to block while serving the child's file
    system.
  - esbuild's synchronous API is unavailable too.
  - lightningcss has no `wasm32-wasi` build. Vite loads it only for
    `css.transformer: 'lightningcss'` and CSS minification, so those fail.
    So does anything else that needs it (`@tailwindcss/vite` is untested
    here).
  - An idle child process is detected heuristically: timers, servers,
    sockets, IPC, threads and in-flight fetches are tracked, and
    WebAssembly threads count as busy even when they are unref'd.
- Not yet tried: SolidStart, TanStack Start, Qwik City and Remix-on-Vite apps
  other than React Router. They use the same pieces.
