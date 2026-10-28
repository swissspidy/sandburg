# ADR 0070: The rolldown trap: V8 sees shared memory growth late; modules with shared memory are guarded

- Status: Accepted
- Date: 2026-10-28

## Context

ADR 0066 left one false alarm open: corpus app 134 (Angular 22, `ng serve`) trapped on a cold run
in Vite's dependency optimizer, inside rolldown 1.2.8's WebAssembly build (`Error during dependency
optimization: … memory access out of bounds`), in about three of four batch runs. The same build
under Node 24 had not trapped in 12 runs.

On a 4-vCPU machine, three cold copies of 134 at a time with one CPU spinner trapped in 1 to 2 of
every 3 runs. Diagnostics put into the installed rolldown and emnapi showed where:

- **The trap is on rolldown's main thread**, in the Rust callback napi-rs attaches to a JavaScript
  promise (`then`). The promise was a load hook's, resolved with a module's code (`{ code }`, an
  rxjs file). The trap was caught there and became the build's error, which is why it reached the
  page as a build failure and not as a crashed thread.
- **The trapping instruction is `memory.fill` in dlmalloc's `calloc`** (wasm function 17023: it
  calls malloc, then `memory.fill(ptr, 0, size)`, the fault at the fill). The chunk malloc returned
  was in bounds.
- **The memory had just grown.** Rolldown's shared memory starts at 16,384 pages (1 GiB) and grows
  in small steps during the optimizer, from 16,417 to about 17,280 pages. Each trap came during that
  growth (16,741 → 16,901 pages in one). Under Node 24 the memory grows the same way, step for step.

The cause is V8's. When one thread grows a shared memory, V8 makes the new size known to the other
threads' instances only when each handles an interrupt, at its next stack check. Plain loads and
stores are checked by guard pages and see the new pages at once. Bulk memory operations
(`memory.fill`, `memory.copy`) and atomic operations check bounds against the size the instance
knows, and `memory.size` returns it. So a thread that learns of new memory through shared memory
and fills, copies to or atomically updates it traps, although the access is in bounds. Here a
tokio thread's malloc grew the heap, and the main thread's calloc was handed a chunk from the new
pages.

A WebAssembly module shows it without rolldown: a thread grows a shared memory a page at a time
and publishes each new page's address with an atomic store. The main thread waits for the address
and accesses the page. These are the counts of 3,000 such rounds with a short handshake per round
(messages between the threads):

| Operation on the new page | Node 24 (V8 13.6) | Chromium 1243 |
|---|---|---|
| `i32.load` or `i32.store` | 0 traps | 0 traps |
| `memory.fill` | 10 traps | 45 traps |
| `memory.copy` | 22 | 31 |
| `i32.atomic.rmw.add` | 21 | 34 |
| `memory.size` too small | 11 | 44 |
| `memory.fill`, after `memory.grow 0` when `memory.size` is too small | 0 | 0 |

With the rounds in WebAssembly alone (no messages between them; the test module), Node 24 traps
in every run of 20,000 rounds for fill, copy and atomic add, and never for a store. Node is not
immune. It hit the window rarely in rolldown, and Sandburg's timing hits it often. Which part of
that timing widens the window (the runtime's main thread doing more between a thread's growth and
its own next stack check, say) was not established.

These were ruled out on the way:

- **Memory limits.** 14 GB was free (ADR 0066), and the memory grows the same under Node.
- **The tiering budget** (ADR 0027's `--wasm-tiering-budget`, 100× V8's default). At V8's default
  134 still trapped.
- **JavaScript exceptions.** No hook, emnapi call or threadsafe function threw first. The
  RuntimeError came from wasm, below the `then` callback.
- **Re-entry into the main thread's WebAssembly.** The runtime's synchronous waits (`Atomics.wait`
  for VFS calls and host files) deliver no messages, so emnapi's `async-work-complete` and
  threadsafe-function messages cannot run while wasm is on the stack.
- **WASI writing past a buffer.** `@tybys/wasm-util` copies reads through a temporary buffer to
  the iovecs' lengths, and `fd_readdir`, `path_readlink` and `fd_prestat_dir_name` write within
  the lengths they are given.
- **A debugger.** Pausing on exceptions (CDP) makes the race disappear (0 of 18 runs, each 4× slower):
  V8 runs debugged WebAssembly differently.

## Decision

**The runtime compiles every WebAssembly module with a shared memory guarded**
(`node-runtime/wasm-grow-guard.ts`, installed in each runtime before the program runs). The
rewrite changes function bodies only. Before each `memory.fill`, `memory.copy`, `memory.init` and
atomic operation (`0xFE` prefix, fences aside), it checks whether the access ends past
`memory.size`. If it does, it runs `memory.grow 0` first, which in V8 updates the current
instance's size. The operands go
through five temporaries added after the function's locals, so the function's own locals and all
indices (functions, types, globals) stay as they are. An access that is out of bounds still traps.
Plain loads and stores are left as they are (guard pages see growth).

- **Why `memory.grow 0` refreshes, and what it costs**: in V8 a grow of shared memory by 0 pages
  is still a grow. `BackingStore::GrowWasmMemoryInPlace` takes it as a "degenerate grow" and
  succeeds (backing-store.cc), and `WasmMemoryObject::Grow` then broadcasts the new size to every
  isolate sharing the memory, unconditionally for shared memory, updating the current one's
  instances before it returns (wasm-objects.cc). That is an implementation detail, not something
  the specification promises: a V8 that returned early for a grow by 0 would silently remove the
  fix, and the unit test's check that the unguarded module still traps (or no longer does) is
  what would show it. It costs a global mutex, an interrupt to every isolate and a new
  SharedArrayBuffer for the memory, which is acceptable because it runs only when the instance's
  size is behind, i.e. right after another thread grew the memory.
- **Where**: `new WebAssembly.Module`, `WebAssembly.compile` and `WebAssembly.instantiate` from
  bytes, with what else they are given (compile options such as `builtins` reach WebAssembly). A
  detached buffer gets WebAssembly's CompileError, thrown or as a rejected promise. A compiled module passed to another thread (emnapi hands its threads the module) is already
  guarded. `WebAssembly.Module` stays the same prototype, so a module made in another thread is still
  `instanceof WebAssembly.Module`, and its statics (`imports`, `exports`, `customSections`) are
  the native ones.
- **What is guarded**: of the corpus installs' modules, rolldown's, oxc-parser's and Tailwind's
  oxide (napi-rs WASI builds with threads). **What is left as it is**: modules without a shared
  memory (esbuild-wasm, lightningcss-wasm, `@tsrs/wasm`, source-map's), with several memories or a
  memory64, with an instruction it does not know (GC, SIMD past relaxed SIMD such as FP16's), with
  typed references anywhere (block, select, local, parameter or result types `(ref …)`), or
  that ends inside a number or a count (it returns at once). So are modules of more than 128 MB,
  and modules the guard would grow by more than half plus 64 KB (real ones grow by 5–8 %; a dense
  run of atomics, valid or not, would cost seconds and gigabytes). A guarded module that does not
  compile is compiled from the bytes as given (copied before an asynchronous compile, as
  WebAssembly copies them), so a program gets WebAssembly's own error for them.
- **Cost**: rolldown's 10.9 MB module takes 110–150 ms to rewrite under Node, once per process, and
  grows by 6.8 % (oxc-parser's 1.5 MB, 13 ms; oxide's 1.7 MB, 66 ms cold). Function bodies without a
  `0xFC` or `0xFE` byte (72 % of rolldown's, 46 % of its code) are copied without decoding. Each
  guarded operation costs a comparison with `memory.size`. App 134 cold, alone, three runs each:
  10.36 s with the guard and 10.25 s without (mean total; the start phase, where rolldown is
  compiled and runs, 6.62 s and 6.22 s). The rewrite is paid once per runtime that compiles the
  bytes, never per thread of a module it receives compiled. In a cold 134 run that was rolldown
  once (134 ms, the main runtime) and oxc-parser in two thread runtimes that load it themselves
  (about 62 ms each, cold). So guarded modules are not cached: a cache across runtimes would need a
  hash and a synchronous lookup through the host or a parent that may be blocked, to save about
  50 ms per such runtime.

## Results

App 134 cold (empty dev caches), three copies at a time with one CPU spinner, on the 4-vCPU
machine:

| | Runs | Trapped |
|---|---|---|
| Without the guard (the same clean install) | 6 | 2 |
| With the guard | 30 | 0 |
| With the guard, alone with four CPU spinners | 10 | 0 |

With the guard, 25 corpus apps cold, three at a time (the 12 Angular apps; Vite 8 apps of
SvelteKit, SolidStart, React Router, Vue, Svelte, Lit and Vue + Express; Nuxt and Astro twice;
Next.js and Vite + React with Tailwind 4) were all right: the 13 that should pass passed, and the
12 faults were caught as `app-bug`.

## Consequences

- WebAssembly threads (napi-rs WASI builds such as rolldown and Tailwind's oxide, and Emscripten
  pthreads) no longer trap on memory another thread just grew, in the runtime. Under Node they
  still can. That is a V8 bug, and the runtime behaves as the threads proposal says.
- `WebAssembly.compileStreaming` and `instantiateStreaming` compile as they are. Node programs
  rarely stream, and napi-rs loaders read the file.
- `memory.size` itself can still return the old size in a thread that has not caught up (the
  rewrite guards accesses, not reads of the size). Code that sizes memory with it, Emscripten's
  `sbrk` say, may grow more than it needs; it does not trap.
- The rewrite counts on guard pages for plain accesses. That holds where V8 uses its trap handler
  (64-bit Linux, macOS and Windows). Without it, plain accesses would need the check too.
- Stack traces of a guarded module name other byte offsets (`wasm-function[i]:0x…`). Function
  indices are the same.
- `signature:wasm-trap` (ADR 0066) stays, for other traps.
