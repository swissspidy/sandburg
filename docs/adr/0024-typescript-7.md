# ADR 0024: TypeScript 7 in the browser runtime

- Status: Accepted
- Date: 2026-10-23

## Context

TypeScript 7 is the native port of the compiler. Its `typescript` package has no JavaScript
compiler: `lib/tsc.js` (which `bin/tsc` imports) runs a native binary from
`@typescript/typescript-<platform>`. The browser runtime cannot run it, so a Next.js app on
TypeScript 7 exited before it listened. Next.js 16 sees that the package has no compiler API and
runs `tsc` as a separate process instead (`experimental.useTypeScriptCli`):

- **`next dev`** (with webpack, as Sandburg runs it) asks for one thing: `tsc --showConfig`, the
  project's configuration with `extends` applied, of which it reads `compilerOptions`.
- **`next build`** also type-checks: `tsc --noEmit -p tsconfig.json`.

The Dependabot update that moved the Next.js fixture to TypeScript 7 failed every suite that runs
it (#34), and ADR 0019 had kept the fixtures on 6.

Two WebAssembly builds of a TypeScript 7 compiler exist on npm:

- [`tsgo-wasm`](https://github.com/sxzz/tsgo-wasm): Microsoft's Go compiler built for WebAssembly,
  at the same versions (7.0.2). 49 MB. Go's loader refuses a large environment (argv and env over
  its limit).
- [`@tsrs/wasm`](https://github.com/oxc-project/tsrs): tsrs, a Rust port of the TypeScript 7
  compiler (oxc, Cloudflare and VoidZero), for Node and browsers. 9.8 MB, and a type check of the
  Next.js fixture took 1.9 s against tsgo-wasm's 7.4 s. Experimental, versioned on its own
  (0.18.0-ts7.1.0-dev.20260929 follows TypeScript 7.1's development), and without `--showConfig`.

## Decision

- **TypeScript 7's `lib/tsc.js` is replaced in the install** (`WASM_BUILDS`,
  [`install-rules.ts`](../../src/adapters/node/install-rules.ts), `TSC_SHIM`), as the native code of
  sass-embedded, rollup, lightningcss and esbuild is:
  - **`--showConfig`** is answered in JavaScript: `tsconfig.json` (comments, trailing commas) and its
    `extends` chain merged, path options relative to the project's config, `${configDir}`, enum
    values in lower case and `plugins` left out, as tsc prints them.
  - **Everything else runs tsrs** (`@tsrs/wasm`, pinned with `wasmVersion`, which installs a
    build at its own version instead of the package's). It runs on the calling thread: its Node
    entry point starts a worker thread for a larger stack, which the runtime does not give one, and
    that worker kept the process from exiting. Its output is collected and written through
    `process.stdout` and `process.stderr`, since a worker thread has no descriptors 1 and 2 there.
- **An extensionless module in `node_modules` is JavaScript** (the host's transform route), as Node
  loads it: ESM in a `"type": "module"` package. `bin/tsc` is one; before, it was sent untransformed
  and failed as CommonJS.
- **The Next.js fixture uses TypeScript 7.** The other fixtures stay on 6: Angular's compiler and
  svelte-check require it (ADR 0019).

## Consequences

- A Next.js app on TypeScript 7 runs, and `tsc` in a dev script type-checks. The e2e tests cover both,
  and a type error stopping a dev script.
- **`--showConfig` is approximate.** It does not add the options tsc derives from others
  (`moduleResolution` and `moduleDetection` from `module: nodenext`, `preserveConstEnums` from
  `isolatedModules`). Next.js reads `paths`, `baseUrl` and the like from it, which it gets right.
- **Diagnostics follow tsrs**, which is experimental and follows TypeScript 7.1, not the 7.0 an app
  installs: a type check can disagree with the app's own `tsc` at the edges.
- **tsrs is pinned.** A newer version is a deliberate bump, with the e2e tests run against it.
- When tsrs supports `--showConfig`, the shim can hand it everything.
