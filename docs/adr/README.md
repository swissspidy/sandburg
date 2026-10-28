# Architecture decision records

Each decision, with its status, as its own header gives them (a new ADR adds its row here).

| ADR | Title | Status |
|---|---|---|
| [0001](0001-runtime-adapters-serving-results.md) | Runtime adapter interface, serving and isolation model, result schema | Accepted (milestone 1); the almostnode adapter it describes was removed in [ADR 0013](0013-runtime-consolidation.md) |
| [0002](0002-snapshots-and-batches.md) | Snapshot-based project input, batches, and proof of network containment | Accepted (milestone 2) |
| [0003](0003-nextjs-and-nodebox.md) | Next.js support, the Nodebox adapter, and what the runtimes need patched | Superseded by [ADR 0013](0013-runtime-consolidation.md) (almostnode and Nodebox were removed) |
| [0004](0004-docker-reference-and-fidelity-study.md) | Docker reference runtime, `sandburg compare`, and the fidelity study | Accepted (milestone 4) |
| [0005](0005-wordpress-playground.md) | WordPress Playground adapter and the per-sandbox egress proxy | Accepted (milestone 5); the WordPress Playground adapter was removed in [ADR 0013](0013-runtime-consolidation.md). The per-sandbox egress proxy stays. |
| [0006](0006-node-runtime.md) | Sandburg's own Node.js runtime for the browser | Accepted |
| [0007](0007-esbuild-adapter.md) | esbuild adapter (Vite-style apps built with esbuild-wasm) | Superseded by [ADR 0014](0014-node-runtime-only.md) |
| [0008](0008-angular.md) | Angular adapter (AOT in the Node.js runtime, bundled with esbuild-wasm) | Superseded by [ADR 0014](0014-node-runtime-only.md) |
| [0009](0009-full-stack-vue-sqlite.md) | Full-stack apps (front end + Node backend), Vue, and SQLite in WebAssembly | Accepted; amended by [ADR 0014](0014-node-runtime-only.md) (the front end runs on its own dev server) |
| [0010](0010-websockets-and-top-level-await.md) | WebSockets (and hot reloading) and top-level await in the node runtime | Accepted |
| [0011](0011-client-frameworks.md) | Svelte, Solid, Preact and Lit in the esbuild adapter | Superseded by [ADR 0014](0014-node-runtime-only.md) |
| [0012](0012-real-vite-and-meta-frameworks.md) | Real Vite in the node runtime (SvelteKit, Astro, React Router, Nuxt) | Accepted; amended by [ADR 0063](0063-synchronous-child-processes.md) (synchronous child processes run) |
| [0013](0013-runtime-consolidation.md) | One Node.js runtime, `--runtime auto`, almostnode, Nodebox and WordPress Playground removed | Accepted; amended by [ADR 0014](0014-node-runtime-only.md) (`--runtime auto`, the esbuild and angular adapters removed) |
| [0014](0014-node-runtime-only.md) | The node runtime runs every project; esbuild and angular adapters removed | Accepted |
| [0015](0015-static-demos.md) | Static demos on GitHub Pages replay the host | Accepted |
| [0016](0016-faster-batches.md) | Fail-fast checks, shared Vite seeds, warm-ups | Accepted |
| [0017](0017-runtime-profile.md) | What a CPU profile of the runtime showed | Accepted |
| [0018](0018-browser-install.md) | npm install in the browser (opt-in) | Accepted |
| [0019](0019-latest-versions.md) | Fixtures test the latest version of every framework | Accepted |
| [0020](0020-compile-in-the-page.md) | With a browser install, the page compiles too | Accepted |
| [0021](0021-generate-in-the-browser.md) | Generate an app in the browser, and run it there | Accepted |
| [0022](0022-npm-package.md) | Publish Sandburg as an npm package | Accepted |
| [0023](0023-checks-in-the-page.md) | Checks that run in the page | Accepted |
| [0024](0024-typescript-7.md) | TypeScript 7 in the browser runtime | Accepted |
| [0025](0025-runtime-hot-path.md) | The runtime's hot path | Accepted |
| [0026](0026-cold-start.md) | Cold starts | Accepted |
| [0027](0027-wasm-tiering-and-spares.md) | WebAssembly tiering budget, lazy spare runtimes | Accepted |
| [0028](0028-runtime-script-libraries.md) | Compile less in the browser: a smaller runtime script, polyfills on first use | Accepted |
| [0029](0029-runtime-io.md) | The runtime's requests to the host | Accepted |
| [0030](0030-host-share.md) | The host's share of a run | Accepted |
| [0031](0031-around-the-app.md) | The fixed costs around the app | Accepted |
| [0032](0032-package-store.md) | A package store and a long-lived resolver for host installs | Accepted |
| [0033](0033-framework-runs.md) | Faster meta-framework runs | Accepted |
| [0034](0034-request-path.md) | The app's requests through the service worker | Accepted |
| [0035](0035-resolution.md) | npm's resolution, read ahead; unpacking and side installs as it goes | Accepted |
| [0036](0036-checks-phase.md) | The checks phase, and what comes after it | Accepted |
| [0037](0037-nextjs-runs.md) | Next.js runs: a seed per router, a shorter start, a shorter Session.close | Accepted |
| [0038](0038-wasm-threads.md) | The dev tools' WebAssembly threads | Accepted |
| [0039](0039-batch-throughput-and-memory.md) | Batch throughput and memory | Accepted |
| [0040](0040-security-fixes.md) | Security fixes: the egress proxy's parser, cache writes, request bodies, lockfile locations, errors | Accepted |
| [0041](0041-runtime-hot-paths.md) | The runtime's own hot paths | Accepted |
| [0042](0042-compiled-code-across-runs.md) | Compiled code across runs: axe-core's from V8, the host's own from disk | Accepted |
| [0043](0043-test-suites.md) | The test suites: speed, reliability and the security model's tests | Accepted |
| [0044](0044-slowest-frameworks.md) | The slowest frameworks: waits that were timers, rolldown's builtin hooks, caches a project keeps | Accepted |
| [0045](0045-cold-runs.md) | Cold runs: trimmed packuments, read-ahead and pushed modules, a lighter host transform path | Accepted |
| [0046](0046-memory-accounting.md) | Memory accounting: each app's renderer, measured | Accepted |
| [0047](0047-lint-dead-code-and-module-structure.md) | A linter, dead code, typed runtime messages and a split runtime | Accepted |
| [0048](0048-data-paths.md) | The bytes between host, page and runtime | Accepted |
| [0049](0049-runtime-module-code-cache.md) | The runtime as a module from Cache Storage: V8's code for every runtime of a run but the first | Accepted |
| [0050](0050-host-under-many-runs.md) | The host under many runs: where a batch waits, and caches several sessions share | Accepted |
| [0051](0051-wasm-tools-work.md) | The WebAssembly tools' work: esbuild's transforms on the host, Vite's config bundle kept | Accepted |
| [0052](0052-deferred-framework-imports.md) | Framework modules loaded at first use; what is left in Next.js, Angular and Nuxt runs | Accepted |
| [0053](0053-invariants-api-and-structure.md) | Security invariants as lint rules, an API report, and the host's largest modules split | Accepted |
| [0054](0054-security-review-round-4.md) | Security review (round 4): registry-only installs, parser fuzzing, the boundary map | Accepted; amended by [ADR 0061](0061-chromium-sandbox.md) (the boundary its map leaves out, between the app and the machine: Chromium's OS sandbox, now on by default, and site isolation) and [ADR 0064](0064-monorepos-and-local-packages.md) (packages inside the project are linked, never given to npm) |
| [0055](0055-known-bugs-round-5.md) | Known bugs (round 5): a dev script's page port, requests no app made, late allocators | Accepted |
| [0056](0056-architecture-rules-and-contracts.md) | The architecture as checked rules, one table per framework, contracts in one module each | Accepted |
| [0057](0057-native-awaits-and-the-runtime-warm-path.md) | Native awaits that carry the async context; the runtime's warm path against Node's | Accepted |
| [0058](0058-nextjs-ready.md) | Next.js' time to ready: source maps for the project only, server chunks compiled ahead, seeds without checks | Accepted |
| [0059](0059-cold-runs-round-5.md) | Cold runs, round 5: the runtime's compiles over the file channel, whole WebSocket messages, cache writes off the host's main thread | Accepted |
| [0060](0060-test-reliability-under-load.md) | Test reliability under load: waits for the thing, not for a time | Accepted |
| [0061](0061-chromium-sandbox.md) | Chromium's OS sandbox on by default, and site isolation | Accepted |
| [0062](0062-ci-setup-and-coverage.md) | CI: one Chromium setup, a browser cache, and the runs that were missing | Accepted |
| [0063](0063-synchronous-child-processes.md) | Synchronous child processes | Accepted |
| [0064](0064-monorepos-and-local-packages.md) | Monorepos and local packages; pnpm and yarn lockfiles | Accepted |
| [0065](0065-ci-on-macos-and-windows.md) | CI on macOS and Windows, and what it found: npm on Windows, lockfiles through a symlink, macOS's free memory | Accepted |
| [0066](0066-fidelity-v7-fixes.md) | What fidelity study v7 found: shadow roots, Solid's hydration, fail-fast and classification | Accepted |
