# ADR NNNN: The await rewrite of installed files on helper threads

- Status: Accepted
- Date: 2026-10-26

## Context

ADR 0057 keeps async functions native: the host scans each async file esbuild outputs, rewrites its
awaits (`node-runtime/await-context.ts`), and checks that the result parses (`new Function`, compiled,
never called). ADR 0057 measured cold starts 8-19% slower. Both steps ran synchronously on the host's
main thread, the thread that answers the runtime's requests for files.

Measured on a 4-core machine, cold runs (empty `.sandburg/`, npm's cache warm), with timers around
the scan and the check and `node --cpu-prof` of the host:

| Fixture | Files | Scanned | Scan | Check | Both |
|---|---|---|---|---|---|
| vite-react-counter | 114 | 3.6 MB | 172-180 ms | 76-82 ms | 0.25 s |
| astro-app | 2,275 | 25 MB | 462 ms | 251 ms | 0.71 s |
| nuxt-app | 1,846 | 23 MB | 934 ms | 349 ms | 1.28 s |
| next-app-router | 1,827 | 38 MB | 1,253-1,397 ms | 533-720 ms | 1.8-2.1 s |

- **The scan, not the check, is most of it** (~70%). The scan ran at 20-27 MB/s here (ADR 0057's
  38 MB/s was Vite's one warm chunk); `new Function` at ~75 MB/s.
- **It is on the critical path.** In next-app-router's host profile (29 s), the main thread was busy
  ~12.3 s; the rewrite was 2.2 s of that (18%), all of it in installed files' transforms
  (`transformForRuntime`; the compile route's share was 37 ms). The runtime asks for its files one at
  a time, and waits on this thread for each.
- **The caches already do (c).** Transforms are cached by content digest (`transforms/v<N>/`), so a
  warm run does not scan; a cold run misses only because the cache is cold.
- **A cheaper check** would be at most the check's ~30%: esbuild could check the rewritten text only
  with a second transform, slower than `new Function`.

## Decision

`adapters/node/await-threads.ts`: a pool of up to two helper threads (`availableParallelism() - 2`,
at least one) runs `contextAwaits` for installed files' transforms. The main thread posts the code
and awaits the answer; esbuild's transforms and the other files' requests go on meanwhile.

- **The same function, the same output.** Each helper runs `contextAwaits` from `await-context.ts`:
  the scan, the cap on open awaits, the size bounds, and the `new Function` check, which compiles and
  never calls. A null answer lowers the file, as before. `TRANSFORM_VERSION` is unchanged.
- **Small code stays on the main thread** (under 1 KB, or no `await`): posting a file costs ~0.03 ms,
  rewriting 1 KB ~0.1 ms.
- **A helper that fails** (an error, an exit) is not used again: the files it had are rewritten on the
  main thread, and so are later ones.
- **Started ahead** with the adapter's `prepare` (beside `warmCompiler`): a helper takes ~90 ms to
  load the scan. Idle helpers do not hold the process open (they are unref'd after their listeners
  are added: a `'message'` listener added after `unref()` refs the worker's port again).
- The compile route (`compileForRuntime`: project files, Vite's SSR modules) stays synchronous: its
  esbuild transform is synchronous too, and its share of the rewrite was 37 ms.

## Consequences

- **Bench** (`scripts/bench.ts --base origin/main --head . --rounds 3`, medians):

  BENCH_TABLE

- The host's main thread in a cold next-app-router run: busy ~12.3 s → ~9.9 s; the rewrite's 2.2 s
  went to the helpers (2.7 s there: two isolates warm their own JIT), `postMessage` +0.08 s.
- Up to two more threads on the host while a cold run transforms; idle after.

## Security

No boundary moves. The helpers are host threads running the same code on the same input: app code is
scanned and compiled with `new Function`, never called, and the scan's bounds (4 MB, 50,000 awaits,
64 open awaits) are the same. Nothing but code text and the rewritten text crosses to and from a helper.
