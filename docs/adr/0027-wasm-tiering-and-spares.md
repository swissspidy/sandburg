# ADR 0027: WebAssembly tiering budget, lazy spare runtimes

- Status: Accepted
- Date: 2026-10-23

## Context

A trace of a warm Vite run showed CPU spent on work the run did not need, competing with the
runtime's thread for the cores:

- **V8 tiering up WebAssembly.** Every run compiles the dev tools' WebAssembly builds anew in its
  own browser context, and V8 optimizes each function once it has run for its tiering budget:
  esbuild's Go build tiered up ~35 functions, 2.5 s of CPU in background compile jobs for a 3.5 s run.
- **Spare runtimes.** A runtime that loads `worker_threads`, or has a napi-rs wasm32-wasi package
  installed, boots `min(8, cores)` spare runtime workers so that threads started while it blocks find
  one ready. Each compiled and evaluated the 2.8 MB runtime at once, ~180 ms of CPU each, and every
  Vite run triggers this (esbuild-wasm loads `worker_threads`; rollup 4's optional `@napi-rs/lzma`
  becomes `lzma-wasm32-wasi`), mostly for nothing.

## Decision

- **The browser runs with `--js-flags=--wasm-tiering-budget=1300000000`** (100× the default), so only
  code that keeps running is optimized. `--liftoff-only` was as good for Vite but gave nothing for
  Next.js and SvelteKit; 1.4× the default gave nothing.
- **A spare runtime (worker name `sandburg-spare`) only compiles the runtime and waits**; its first
  message evaluates it. A process that loads `node:wasi` (napi-rs builds do, just before starting
  their threads) wakes its spares, so rolldown's threads find them ready.

## Consequences

- The gain is CPU, and shows where cores are contended. A 12-app batch in 3 tabs, with ADRs 0025 and 0026: 34.9 s → 31.4 s
  (median of 3 interleaved rounds, the same 10 apps passing). On an idle machine, single warm runs
  are unchanged by the budget (`vite-react-counter` 3.43 s → 3.45 s, `next-app-router` 5.91 s →
  5.97 s, n=4); on a loaded one they were 20-35% faster (each commit message has the numbers).
- The flag applies to the browser Sandburg launches, not to a page a user opens elsewhere.
