# ADR 0019: Fixtures test the latest version of every framework

- Status: Accepted
- Date: 2026-10-01

## Context

The fixtures had drifted. One Angular app was on Angular 19, the Next.js app on 15.5, the Vite +
React counter on React 18 and Vite 5, Express on 4. Apps generated today, by people or by LLMs,
start from the latest versions. A sandbox that passes on last year's versions says little about
this year's apps.

## Decision

- **Every fixture uses the latest release of its framework** and of its tools, as far as the
  framework's own peer ranges allow. TypeScript stays on 6.0: Angular 22's compiler and
  svelte-check require it, and TypeScript 7 (the native port) has no JavaScript compiler to run in
  the browser.
- `angular-19-zone` became `angular-zone`, an Angular 22 app that keeps what made it worth having:
  zone.js, SCSS and the `@angular-devkit/build-angular` builders, next to the zoneless
  `@angular/build` app.
- **Dependabot keeps the fixtures current**, majors included, grouped per fixture. A failing
  update is a new version that Sandburg does not run yet, which is what the fixtures are for.
- The warm-up projects (ADR 0016) follow the same versions.
- The fidelity corpus keeps its pinned versions: it is a record of a study.

## What the move to the latest versions found

Next.js 16 did not start. Three causes, each fixed in the runtime rather than in the fixture:

1. **SWC's WebAssembly build no longer outputs CommonJS.** `@next/swc-wasm-nodejs` 16 ignores
   `module: { type: 'commonjs' }` (15.5 honoured it), so `next.config.ts`, which Next.js transpiles
   with SWC and then requires, stayed ESM. Real Node 24 strips TypeScript types itself, so the
   runtime now reports `process.features.typescript === 'strip'` (its loader already stripped
   types). Next.js is started with the setting that `--experimental-next-config-strip-types` sets,
   so it imports the config through Node instead of SWC.
2. **Turbopack is the default bundler**, and it has no WebAssembly build. A source patch makes
   webpack the default when SWC runs as WebAssembly (`NEXT_TEST_WASM`). An explicit `--turbopack`
   is left as the app asked.
3. **`Buffer#indexOf` with a `Uint8Array`.** Node accepts any `Uint8Array` where the `buffer`
   polyfill accepted only a `Buffer`. The runtime's `indexOf`, `lastIndexOf`, `includes` and
   `equals` now accept both.

Angular 22 with zone.js, React 19.3 on Vite 8, Express 5, Preact 11 and Nuxt with vue-router 5 ran
without changes.

## Consequences

- Support claims follow the fixtures: the README names the versions they test.
- Each new major is found by a Dependabot pull request whose e2e jobs fail, not by a user.
