# ADR 0062: The await rewrite of installed files on a helper thread

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
- **Caching by digest is already there.** Transforms are cached by content digest (`transforms/v<N>/`), so a
  warm run does not scan; a cold run misses only because the cache is cold.
- **A cheaper check** would be at most the check's ~30%: esbuild could check the rewritten text only
  with a second transform, slower than `new Function`.

## Decision

`adapters/node/await-threads.ts`: one helper thread runs `contextAwaits` for installed files'
transforms. The main thread posts the code and awaits the answer; esbuild's transforms and the other
files' requests go on meanwhile.

- **The same function, the same output.** The helper runs `contextAwaits` from `await-context.ts`:
  the scan, the cap on open awaits, the size bounds, and the `new Function` check, which compiles and
  never calls. A null answer lowers the file, as before. `TRANSFORM_VERSION` is unchanged.
- **One helper, not a pool.** With two (`availableParallelism() - 2` on this machine), a cold
  astro-app run was 11% *slower* than main (3 rounds: 16.8-18.0 s against 16.0-16.3 s): the helpers
  took cores from the browser's threads and esbuild. With one, 4% faster.
- **Started by the first file it would take**, not ahead: a warm run, whose transforms are all cached,
  starts none (a helper started with the adapter's `prepare` loaded the scan, ~90 ms, on another
  core during every warm start, and warm astro-app measured +6%). Until it is ready (its first
  message, once it has loaded the scan), files are rewritten on the main thread, as before.
- **Small code stays on the main thread** (under 1 KB, or no `await`): posting a file costs ~0.03 ms,
  rewriting 1 KB ~0.1 ms.
- **A helper that fails** (an error, an exit) is not started again: the files it had are rewritten on
  the main thread, and so are later ones.
- **It does not hold the process open**: unref'd while it has no files, after its listeners are
  added (a `'message'` listener added after `unref()` refs the worker's port again; a test runs a
  process that starts one and checks that it exits).
- The compile route (`compileForRuntime`: project files, Vite's SSR modules) stays synchronous: its
  esbuild transform is synchronous too, and its share of the rewrite was 37 ms.

## Consequences

- **Bench** (`scripts/bench.ts --base origin/main --head . --rounds 5`, interleaved, medians; base
  c9e2273):

  | Fixture | Mode | Total | Rounds (base / head) |
  |---|---|---|---|
  | vite-react-counter | cold | 6.72 → 6.22 s (−7%) | 5.7-7.4 / 5.9-6.4 s |
  | astro-app | cold | 17.17 → 15.79 s (−8%) | 15.3-18.7 / 14.3-17.3 s |
  | next-app-router | cold | 22.74 → 22.16 s (−3%) | 21.7-24.6 / 21.9-24.7 s |
  | vite-react-counter | warm | 1.66 → 1.62 s (−2%) | 1.6-1.7 / 1.6-2.2 s |
  | astro-app | warm | 4.07 → 3.95 s (−3%) | 3.8-4.4 / 3.8-4.7 s |
  | next-app-router | warm | 4.75 → 4.53 s (−5%) | 4.3-5.0 / 4.4-4.9 s |

  Cold runs vary by 2-3 s here, so these medians are a direction, not a measurement of the size of
  the gain: the profile's 0.25-2.1 s of main-thread time is the most the change can recover, and
  part of it overlapped other work before. Warm runs do not use the helper.
- The host's main thread in a cold next-app-router run: busy ~12.3 s → ~9.9 s (profiled with the first, two-helper version); the rewrite went to
  the helper, `postMessage` +0.08 s.
- One more thread on the host while a cold run transforms; idle after.

## Security

No boundary moves. The helper is a host thread running the same code on the same input: app code is
scanned and compiled with `new Function`, never called, and the scan's bounds (4 MB, 50,000 awaits,
64 open awaits) are the same. Nothing but code text and the rewritten text crosses to and from the helper.
