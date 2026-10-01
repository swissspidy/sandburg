# ADR 0008: Angular adapter (AOT in the Node.js runtime, bundled with esbuild-wasm)

- Status: Superseded by [ADR 0014](0014-node-runtime-only.md)
- Date: 2026-09-30

## Context

Angular CLI apps (`ng serve`) are built by `@angular/build`. It runs these
steps:

1. The Angular compiler (ngtsc, from `@angular/compiler-cli`) compiles the
   app ahead of time (AOT), with template type-checking.
2. The Angular Linker (a Babel plugin) turns libraries' partial declarations
   (`ɵɵngDeclare*`) into full definitions.
3. esbuild bundles the result.
4. Vite serves the bundle.

Several of the CLI's dependencies are native code: esbuild, rolldown, lmdb,
sass-embedded, @parcel/watcher and oxc-parser. So the CLI itself cannot run
in the browser.

Its core steps are pure JavaScript, though. Angular 22's compiler still
runs on TypeScript 6.0, the last JavaScript implementation, since
TypeScript 7 is native. The linker is Babel, and `sass` is Dart Sass
compiled to JavaScript. The two runtimes Sandburg now has can run those
steps:

- the Node.js runtime (ADR 0006) runs Node programs,
- the esbuild adapter (ADR 0007) bundles in the browser.

## Decision: `ng serve`, recomposed from the app's own tools

The `angular` runtime (`src/adapters/angular/`) goes through these steps:

- **Install.** The host installs dependencies with npm (`--ignore-scripts`),
  using the shared cache. No package code runs on the host.
- **Workspace.** The adapter reads `angular.json` as `ng serve` does. It
  takes the default or first application project, and the build target's
  options merged with the configuration that the serve target uses
  (development). Supported builders: `@angular/build:application` and
  `@angular-devkit/build-angular:application`, `browser-esbuild` and
  `browser`.
- **Compile.** `ngc-driver.cjs` runs in a Node.js runtime worker. It uses the
  app's own `@angular/compiler-cli` and `typescript`, through `NgtscProgram`
  with the app's tsconfig, as `@angular/build` does:
  - it sets both `readResource` and `transformResource`, so that inline
    styles are preprocessed asynchronously,
  - Sass (component styles, `inlineStyleLanguage`, global styles) is
    compiled with the app's `sass`, resolving `@use 'pkg'` from
    node_modules,
  - error diagnostics fail the run as an `APP` error with Angular's
    formatting (`file:line:col - error NG…/TS…`), so template errors and type
    errors are app bugs, as in `ng serve`.

  The worker reports back with `process.send()`. This is new in the runtime:
  `init.ipc` gives the program an IPC channel in both directions, as
  `child_process.fork` does.
- **Link and bundle.** The emitted JavaScript replaces the TypeScript
  sources. An entry module imports the polyfills (for example zone.js), the
  global styles and the main file, in that order. esbuild-wasm bundles it,
  with the page's `index.html` plus a module script.
  - While bundling, each node_modules file containing `ɵɵngDeclare` goes
    through the Angular Linker: the app's own Babel plugin, with
    `linkerJitMode: false`. It runs in two linker workers that start
    alongside the compile worker, so Babel is loaded by the time it is
    needed.
  - Defines are set as `@angular/build` sets them for a development
    browser build: `ngJitMode`, `ngServerMode` and `ngI18nClosureMode` are
    all false.
  - Tailwind v4 in global styles (via `@tailwindcss/postcss`) goes through
    the esbuild adapter's Tailwind step.
- **Serving.** Serving goes through the service worker. angular.json assets
  are served at their outputs, and any path that looks like a page gets
  `index.html`.

## Consequences

- The fixtures pass all their checks:
  - `angular-tasks` is an Angular 22 CLI app (zoneless, signals, reactive
    forms, `@for`/`@if`, inputs and outputs, a pipe, and a lazily loaded
    route),
  - `angular-19-zone` is an Angular 19 CLI app (zone.js, SCSS, TypeScript
    5.7, Babel 7).
- Timings for `angular-tasks` with a cached install: about 12 s end to end.
  Compiling takes about 6 s, which includes loading TypeScript in the
  worker. Linking and bundling take about 3.6 s.
- Fidelity: the compiler is the real one, so compile errors match `ng serve`.
  One of the fixture's own bugs is proof: `(ngSubmit)` without a `[formGroup]`
  does not fire, the page reloads, and the check fails, just as it would
  with the CLI.
- The Docker reference now runs Angular projects with `npm start -- --host
  --port`. This could not be verified here, because there is no Docker.
- Not covered:
  - SSR (only the browser build is served),
  - i18n (`localize`),
  - `fileReplacements`,
  - PostCSS plugins other than Tailwind v4,
  - Less and Stylus,
  - custom webpack configs,
  - Nx workspaces without angular.json,
  - HMR (not needed for tests).
- Not faster than native. The compile step is TypeScript's own speed
  (single-threaded). Linking could be cached per library version, but only
  if the host did the linking or verified the cache: a cache written from
  the browser could be poisoned by one sandbox for others. For now each run
  links again.
