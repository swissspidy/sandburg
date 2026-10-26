# ADR 0057: Native awaits that carry the async context; the runtime's warm path against Node's

- Status: Accepted
- Date: 2026-10-26

## Context

Round 5 asked where the in-browser runtime is *structurally* slower than Node.js on the warm path of
Vite-based frameworks, and what different design would close the gap. Measured on a 4-core machine
(Chromium 153, warm runs: the second run of a fixture in a session), with `scripts/profile.ts`,
a per-file timer around the loader's `eval` and `new WebAssembly.Module`, the transfer trace
(`SANDBURG_TRACE_TRANSFERS=1`), and the same programs under Node 22 on the same machine:

- **Node against the runtime.** `vite-react-counter`: Node imports Vite in ~150 ms and listens ~80 ms
  later; the runtime's start is ~0.55 s. `astro-app`: Node imports Astro in 0.63 s, starts its dev
  server in 0.35 s, and renders the first page in 1.8-2.4 s (the dependency optimizer's first
  request); the runtime's start is ~1.0 s and its ready ~2.0 s. The runtime is not slower than Node
  at serving Astro's first page; it is slower at starting.
- **Where a warm start goes** (the program's thread, `vite-react-counter`): init (~125 ms, mostly
  waiting for the dev cache's bundle: 44-90 ms), Vite's import (~500 ms: rolldown's WebAssembly binding
  ~140-280 ms, Vite's chunks' top-level compile), then the server's creation.
- **Top-level compile** (the loader's `eval` of each module's wrapper: parse and compile of its
  top level, timed without a profiler): `vite-react-counter` 62 files, 2.8 MB, 73-85 ms;
  `astro-app` 1,020 files, 8.9 MB, 229 ms; `sveltekit-app` 704 files, 15 MB, 280 ms (TypeScript's
  9 MB alone 129 ms, loaded by SvelteKit's sync). ~54 MB/s: V8's parser speed. Node pays the same,
  and no code cache reaches a worker in a fresh browser context (ADRs 0042, 0049).
- **Async functions.** The runtime carries AsyncLocalStorage's context itself (ADR 0006), and a
  native `await` resumes without anything it can hook, so every async function it ran (all of
  node_modules, the project's files, Vite's SSR modules) was lowered by esbuild to a generator driven
  by `.then` (`__async`). A microbenchmark of nested awaits on Node's V8: native 59-65 ms, lowered
  555-904 ms (with or without the patched `then`): the generator is the cost. Turning the lowering off
  (an experiment that loses the context) made warm runs 4-8% faster: `astro-app` 4.19 → 3.85 s,
  `vite-react-counter` 1.64 → 1.57 s, `sveltekit-app` 3.36 → 3.28 s (start −12%) (n=3).
- **A race at start.** Files the preload bundle only names (WebAssembly binaries over 10 MB, rolldown's
  11 MB among them) are downloaded on the side by the runtime's file helper, and a read waits for that
  download, but only if the helper is running: a new worker gets its parent's messages only once the
  parent has run a task after the worker's script ran, and from its init the runtime runs its program
  in one long task. The helper was started at init: in 2 of 4 warm `vite-react-counter` runs, the
  program's read of rolldown's binary made a synchronous request of its own (63-81 ms) while the
  helper downloaded the same 11 MB again.
- **WebAssembly compile** on the program's thread: rolldown's binding 28-40 ms, Astro's compiler
  12-13 ms per run (timed without a profiler).
- **Event loop** (a program run under both, by the runtime tests' harness): `process.nextTick`
  callbacks run after promise callbacks queued before them (Node runs ticks first), and the
  microtasks of a `setImmediate` callback run after the immediates queued with it (Node runs them
  between). Not changed here (see "Not done").

## Decision

### Native async functions; each await restores the context (`node-runtime/await-context.ts`)

Async functions stay native, and the host rewrites each `await` so that it restores the context
itself:

```js
async function f(x) {                         async function f(x) {
  try {                                         const __sbac = __sandburg_ac.e(); try {
    const v = await g(x);                         try {
    return use(v);                       →          const v = __sandburg_ac.r(__sbac, await __sandburg_ac.s(__sbac, g(x)));
  } catch (e) { log(e); }                           return use(v);
}                                                 } catch (e) {__sandburg_ac.k(__sbac); log(e); }
                                                } finally { __sandburg_ac.x(__sbac); }}
```

- **The calls** (`awaitContext` in `async-context.ts`, a frozen, non-writable global of each
  runtime). Each call of an async function has its own state (`__sbac`: a nested async function's
  shadows it). `s` notes the function's context as it suspends, and gives the microtask that resumed
  it its own context back; `r` restores the function's context when the await resumes; `k`, at the
  start of a catch or finally block, does the same when a rejected await resumed there (the only path
  on which `r` does not run); `x` hands the context back as the function returns or throws. So the
  context between tasks and microtasks stays what it was (callbacks scheduled outside any context see
  none), and `enterWith` in an async function lasts for its later awaits, as in Node. The awaited
  value passes through unchanged: an await takes the ticks it takes in Node.
- **Async generators and `for await`** are still lowered by esbuild (to generators, and to native
  awaits that the rewrite then handles); the patched `then`, `queueMicrotask` and timers stay.
- **Where an await's operand ends** comes from a scan of esbuild's output, not a parse: a tokenizer
  that tells regular expressions from divisions, follows brackets and template literals, and knows
  enough of the statement structure to find functions (declarations, expressions, arrows, methods)
  and catch and finally blocks. An await's operand is a unary expression: prefix operators, a
  primary, then its postfix chain (members, calls, indexes, tagged templates, `++`). It runs at
  ~38 MB/s; acorn parses at ~9 MB/s (its tokenizer alone ~21).
- **Checked.** The same rewrite done from acorn's AST (`test/unit/await-oracle.ts`) produced the
  same text for every async file of nine fixtures' installs (3,386 files, 275 MB of esbuild's output),
  for handwritten shapes, and for random async programs (`test/unit/await-fuzz.ts`: esbuild's output
  of them, plain and minified; the unit test runs a fixed seed, and ~43,000 valid programs were run while
  fixing the scan). A review's differential fuzzing found shapes the first scan misread with code
  that still parsed (so the parse check passed it): a class expression in another's `extends`
  (`class S extends Mixin(class {}) {…}`: its body read as a block, its methods' awaits left
  alone, or using an outer function's state), members named `class` or `function` (`static
  function = 'f';`), `of`, `yield`, `let` and `await` used as names (a `/` after them divides; one
  case rewrote text inside a string), `async` as a name in an await's operand, a number followed
  by a member (`.5.of`); a re-review, a function expression in an `extends` clause
  (`class D extends function () {…} {`, whose body was taken for the class's) and a `{` after a
  for head's `;` (taken for a block). All are fixed and are shapes in the tests now, and a runtime test runs
  them against Node's output. At run time, the host checks that the rewritten code parses
  (compiled with `Function`, never called); code the scan does not understand, or whose result
  does not parse, is lowered as before.
- **Lowered on purpose**: a catch parameter whose pattern has a default (`catch ({ m = f() })`: it
  runs before the catch block, where a rejected await's context is restored; `catch ({ message })`
  is rewritten), code with `with`
  (the names the rewrite adds would resolve through its object), and code over 4 MB or with more
  than 50,000 awaits (see Security). `s` also restores the function's context if it finds the
  call still marked suspended. Every place that lowered does this: installed files (`install.ts`), the host's
  compile of project files, Vite's SSR modules and webpack's `eval` literals (`compile.ts`), and the
  page's compiler for installs in the browser. `TRANSFORM_VERSION` and the compile cache's key change.

### The file helper starts before init

The page sends the runtime it prepares as it loads (ADR 0031) a `prepare` message; the runtime starts
its file helper then, while it waits idle for its init, and init takes that helper (or terminates it,
for a runtime that turns out not to need one: an install in the browser). The helper is running by
the time the program reads a file downloaded on the side.

## Consequences

- **Interleaved warm A/B** (`scripts/bench.ts`, both sides as refs, 5 rounds, medians; each side's
  `.sandburg/` carried over between rounds):

  | Change | Fixture | Total | Phase |
  |---|---|---|---|
  | File helper before init | vite-react-counter | 1.65 → 1.62 s (−2%) | install 0.26 → 0.25 s |
  | | lit-vite | 1.37 → 1.29 s (−6%) | start 0.48 → 0.45 s |
  | Native awaits | astro-app | 4.04 → 3.73 s (−8%) | ready 2.11 → 1.92 s |
  | | sveltekit-app | 3.27 → 3.15 s (−4%) | start 1.20 → 1.11 s |
  | | lit-vite | 1.33 → 1.29 s (−3%) | ready 0.30 → 0.26 s |
  | | vite-react-counter (8 rounds) | 1.55 → 1.52 s (−2%) | ready 0.36 → 0.35 s |

  After the first change, 0 of 4 warm `vite-react-counter` runs made the synchronous request for
  rolldown's binary (2 of 4 before).
- **The branch against the origin/main it started from** (860c0eb), warm, medians:

  | Fixture | Rounds | Total | Phase |
  |---|---|---|---|
  | solid-start-app | 3 | 3.53 → 3.23 s (−9%) | start 0.71 → 0.58 s, ready 1.64 → 1.54 s |
  | react-router-app | 3 | 2.46 → 2.26 s (−8%) | ready 0.55 → 0.51 s |
  | nuxt-app | 3 | 4.89 → 4.67 s (−5%) | ready 3.12 → 2.85 s |
  | astro-app | 5 | 3.80 → 3.62 s (−5%) | ready 1.97 → 1.86 s |
  | sveltekit-app | 5 | 3.12 → 3.09 s (−1%) | ready 1.07 → 1.03 s |
  | lit-vite | 5 | 1.33 → 1.32 s (−1%) | ready 0.30 → 0.28 s |
  | vite-react-counter | 5 | 1.45 → 1.51 s (+4%: two head rounds at 2.1 and 1.7 s; the 8-round A/B of the second change above: −2%) | |

  The SSR frameworks gain most: their requests run async code (render, loaders, the module runner)
  whose awaits were generators; a Vite SPA's server does little of it.
- **Cold**, 3 rounds: `vite-react-counter` 5.90 → 5.77 s, `astro-app` 16.11 → 16.29 s. The host scans
  and checks what it transforms (start +8-19%; install and ready moved the other way); transforms
  are cached by content, so a warm run pays nothing.
- **Behaviour changes** (closer to Node): stack traces of async code have Node's `at async` frames;
  awaits take Node's ticks; `Function.prototype.toString` of an async function shows an async function
  (with the context calls) instead of a generator. AsyncLocalStorage gives the same results as before
  and as Node: `test/runtime/async-context.test.ts` runs one program written against Node's output
  (concurrent stores, rejections into catch and finally, methods, arrows, async generators,
  `for await`, `enterWith`, timers, no context leaking into callbacks scheduled outside one), and the
  e2e suites (frameworks, vite-frameworks, node with Next.js, fullstack, browser-install, run) pass.
- **Code**: `await-context.ts` (~790 lines with its scanner), the oracle and tests; `install.ts` and
  `compile.ts` call it where they lowered.

## Security

No boundary moves. The host still never runs app code: it compiles the rewritten text with `Function`
to check that it parses and never calls the function (as acorn and esbuild parse app code today); the
rewrite only inserts fixed text at token boundaries, and code it does not understand goes to esbuild's
lowering as before. The scan is a new parser of app-controlled input on the host (the compile route
takes up to 32 MB), so it is bounded: it does not recurse; its work is linear in the input except for
awaits whose operands are open at once (each token moves every open one on), which it caps at 64
(`await await …` 100,000 times would otherwise be quadratic); code over 4 MB or with more than 50,000
awaits is not scanned at all but lowered in one esbuild pass (as before this change: 8 MB of
await-dense code compiles in ~1.2 s and ~190 MB, as on main; the first version of the scan took
8.2 s and 877 MB, and was OOM-killed at 60 MB); its edits are kept in typed arrays and its output
joined once; and any failure of its own lowers the code. Fixed-seed fuzz tests feed it token soups,
random programs and the crafted inputs. The transform caches stay keyed by content digests (and by the compiler's sources,
which now include `await-context.ts`). The global the rewritten code calls is each runtime's own,
defined before any program code, frozen and not writable, in each sandbox's own runtime. The `prepare`
message comes from the sandbox's own host page to the runtime it created, and only starts the
runtime's own helper (the same worker init started before), which still talks only to its own
sandbox's file channel.

## What did not help

- **Compiling WebAssembly ahead in the page, for V8's process-wide module cache.** A worker's
  synchronous `new WebAssembly.Module` of rolldown's 11 MB took 35-47 ms whether or not the page had
  compiled the same bytes (`WebAssembly.compile`) and kept the module alive, also with
  `--wasm-lazy-validation`. Only a compiled module received by message would help, which the
  program's thread could take only at a point where it yields (it does not, from init to Vite's
  import): 28-40 ms a run.
- **A native-await helper driving esbuild's generators** (`__async` with `await` inside, the
  context restored around each `next()`): 689-706 ms in the microbenchmark, against 555-698 for
  esbuild's: the generator is the cost, not the promise machinery.
- **acorn for the rewrite**: 9 MB/s on Vite's 1.4 MB chunk (150 ms), its tokenizer 21 MB/s; the scan
  is the same output at ~38 MB/s.

## Not done

- **Node's event loop order**: `process.nextTick` callbacks before promise callbacks, and microtasks
  drained between `setImmediate` callbacks. Ticks before promises needs the runtime to drain its tick
  queue at the end of every callback it makes (timers, immediates, messages, fs), as Node's
  `processTicksAndRejections` does; immediates one per task would drain microtasks between them.
- **The bundles at init**: the runtime waits 44-224 ms at init for the dev cache's and the preload
  bundle's download (the page's fetch runs at ~90-170 MB/s here, its first byte 4-40 ms after the
  request). ADR 0048 found streaming them no faster; the transfer itself is what is left.
- **WebAssembly compile at start** (above): rolldown's 28-40 ms, Astro's compiler's 12-13 ms.
- **Top-level compile** (`eval` of each module, 73-280 ms of a warm start): V8's parser speed, and no
  code cache reaches a worker in a fresh context. SvelteKit's sync loads TypeScript (9 MB, 129 ms)
  every start.
- **Vite's SSR modules rewritten in the runtime**: `new AsyncFunction` bodies still go to the host's
  compile (cached); the scan could run in the runtime for bodies without `import()`, but Vite's SSR
  output is not esbuild's (no guaranteed semicolons), which the scan relies on for statements.
- **The scan's speed**: ~38 MB/s; the cold start's host transforms pay it once per file content.
