# ADR 0007: esbuild adapter (Vite-style apps built with esbuild-wasm)

- Status: Accepted
- Date: 2026-09-29

## Context

almostnode runs Vite apps with its own dev server and loads dependencies
from esm.sh (ADR 0003). That has drawbacks:

- esm.sh rebuilds packages, so what runs is not the package that
  `npm install` would give.
- Resolution differs from Vite's.
- Tailwind v4 is not applied.

For a browser-only app, the dev server adds little to a test run. What
matters is that the same modules end up in the page. esbuild is a bundler
that runs in the browser as WebAssembly.

## Decision 1: Build once, serve the output from the service worker

- **Install.** The host installs dependencies with npm
  (`--ignore-scripts`), using the same cache as the node runtime (ADR 0006).
  They are real npm packages, with lockfiles honored.
- **Build.** At start, the host page initializes esbuild-wasm and bundles
  `index.html`'s module scripts in one pass (`src/adapters/esbuild/build.ts`):
  - ESM output with code splitting and source maps,
  - TS, TSX and JSX (automatic runtime, `jsxImportSource` from tsconfig),
  - JSON, CSS and CSS modules,
  - assets as files, plus `?url`, `?raw` and `?inline`,
  - `import.meta.env` (MODE, DEV, PROD, SSR, BASE_URL, and `VITE_*` from the
    `.env` files Vite reads), `%VITE_*%` in `index.html`, and
    `process.env.NODE_ENV`.
- **Serving.** The build output is kept in memory. The sandbox's service
  worker (the node runtime's `sw.js`) forwards app requests to the host page,
  which answers from memory. As in Vite, `public/` is served at the root,
  other project files are served as-is, and unknown paths fall back to
  `index.html` (SPA routing).
- **Resolution.** `src/adapters/esbuild/resolve.ts` implements it in a
  plugin, because esbuild-wasm has no file system:
  - project-root-absolute paths and aliases (tsconfig `paths`, simple
    `resolve.alias` entries in vite.config),
  - extension and index probing, and `.js` → `.ts`,
  - `exports` with conditions browser, import, module, development and
    default (`style` first for CSS `@import`),
  - the `browser` field (string and object forms), then `module`, then
    `main`,
  - Node built-ins become empty modules with a warning, as Vite
    externalizes them.
- **Reading dependencies.** Files are fetched lazily from the host, one
  node_modules directory per request (`/__sandburg/nm/<key>/d/<dir>`), with
  at most 24 requests in flight. Without batching, lucide-react's
  re-exports alone make about 1,600 requests. Dependencies' `sourceMappingURL`
  comments are removed.
- **Failures.** A build error is an `APP` error, so it is classified as an
  `app-bug` with esbuild's file:line:column. A dependency that cannot be
  fetched is classified as infra.

## Decision 2: Tailwind CSS v4 without its Vite or PostCSS plugin

Tailwind v4's compiler (`compile()` from `tailwindcss`) is plain JavaScript
with no dependencies. For CSS that uses Tailwind (`@import "tailwindcss"`,
`@theme`, `@plugin`, …), the build does the following:

- It bundles the app's own installed `tailwindcss` with esbuild-wasm and
  imports it, so the version is the app's.
- It serves `@import` and `@plugin`/`@config` through the same resolver.
- It builds the utilities from candidates scanned from the project's source
  files. Tailwind's own scanner (Oxide) is native code. The simpler scan
  over-collects, and Tailwind ignores tokens that are not classes.

`@tailwindcss/vite` and `@tailwindcss/postcss` are therefore accepted. Other
Vite plugins and PostCSS plugins are rejected at probe time as
`runtime-unsupported`, and so is Tailwind v3, which is a PostCSS plugin.
autoprefixer is accepted, because Chromium does not need prefixes.

## Consequences

- Fidelity on the synthetic corpus from ADR 0004 (100 apps, seed 1). There is
  no Docker in this environment, so the comparison is against the v2 study's
  Docker reference results for the same apps:

  | | Vite apps run | Agreement with Docker | Agreement with ground truth | Median time per app |
  |---|---|---|---|---|
  | esbuild adapter | 67 of 67 (33 Next.js apps are out of scope) | 67/67 (100%) | 64/67 (95.5%) | 5.0 s (4 in parallel; cold npm installs included) |

  The 3 misses against ground truth are the corpus's phantom-dependency apps
  (`nanoid` is hoisted by npm). The Docker reference passes them too (ADR 0004).
  All 9 Vite + Tailwind v4 apps pass. almostnode could not apply their styles.
- Speed: `vite-react-counter` passes in about 3 s end to end, and the build
  takes about 1.6 s including esbuild-wasm startup. Apps with very large
  dependency graphs are slower, because esbuild-wasm runs several times
  slower than native esbuild. lucide-react's 1,600 modules take about 5 s,
  compared with 0.9 s natively. If this matters, the next step is Vite-style
  dependency pre-bundling, cached per install key. That could even run on
  the host with native esbuild, since pre-bundling only transforms code and
  runs none of it.
- Not covered:
  - Vite plugins other than React and Tailwind v4 (Vue, Svelte, SVGR, …),
  - `import.meta.glob`,
  - PostCSS, Sass and Less,
  - HMR (not needed for tests),
  - Vite's `server.proxy`, since there is no backend.
- WebContainers stays out (commercial). The esbuild adapter and the node
  runtime (ADR 0006) are both Apache-2.0, like the rest of Sandburg.
