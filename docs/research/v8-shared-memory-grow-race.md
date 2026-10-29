# Draft V8 bug report: other threads see shared memory growth late (bulk memory and atomic ops trap)

Draft, not filed (ADR 0070). Upstream: https://issues.chromium.org/issues (component Blink>JavaScript>WebAssembly).

## Summary

After one thread grows a shared `WebAssembly.Memory` (`memory.grow`), another thread that learns of
the new pages through an atomic (a happens-before edge) and then runs `memory.fill`, `memory.copy`
or an atomic read-modify-write on them traps with `RuntimeError: memory access out of bounds`,
although the access is within the memory's current size. `memory.size` in that thread can also
return the old size. A plain `i32.store` (or load) to the same address succeeds. Running
`memory.grow 0` in that thread first makes the access succeed.

It looks as if the other isolates' instances keep the old memory size until they handle the
grow-shared-memory interrupt, while bulk memory and atomic operations check bounds against that
cached size (plain accesses are checked by the trap handler's guard regions). The threads proposal
asks that an access ordered after the growth sees it, as plain accesses do.

## Versions

- Node 24.22.2 (V8 13.6.233.17-node.63), Linux x86_64
- Chrome for Testing 153.0.8010.12, headless, Linux x86_64 (cross-origin isolated page, dedicated
  workers)

## Real-world impact

Rolldown's WebAssembly (wasm32-wasip1-threads) build traps in dlmalloc's `calloc`: a worker thread's
malloc extends the heap with `memory.grow`, and the main thread's `calloc` is handed a chunk from
the new pages and traps in `memory.fill(ptr, 0, size)`. Vite's dependency optimizer failed
intermittently on cold starts under load because of it.

## Reduced test case

One thread (`writer`) grows the memory a page at a time and publishes each new page's address with
an atomic store at [0], then waits for the reader's acknowledgement at [4]. The other (`reader`)
waits for each address and accesses the page: op 0 `memory.fill`, op 1 `memory.copy`, op 2
`i32.atomic.rmw.add`, op 3 `i32.store`.

```wat
(module
  (import "env" "memory" (memory 1 65536 shared))
  ;; [0]: address the writer published, [4]: rounds the reader finished
  (func (export "writer") (param $n i32) (result i32)
    (local $i i32) (local $addr i32)
    (block $out (loop $round
      (br_if $out (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $addr (i32.add (i32.shl (memory.grow (i32.const 1)) (i32.const 16)) (i32.const 64)))
      (br_if $out (i32.lt_s (local.get $addr) (i32.const 64)))
      (i32.atomic.store (i32.const 0) (local.get $addr))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (loop $ack (br_if $ack (i32.lt_u (i32.atomic.load (i32.const 4)) (local.get $i))))
      (br $round)))
    (local.get $i))
  (func (export "reader") (param $n i32) (param $op i32) (result i32)
    (local $i i32) (local $addr i32) (local $last i32)
    (block $out (loop $round
      (br_if $out (i32.ge_u (local.get $i) (local.get $n)))
      (loop $wait
        (local.set $addr (i32.atomic.load (i32.const 0)))
        (br_if $wait (i32.eq (local.get $addr) (local.get $last))))
      (local.set $last (local.get $addr))
      (if (i32.eqz (local.get $op))
        (then (memory.fill (local.get $addr) (i32.const 7) (i32.const 16))))
      (if (i32.eq (local.get $op) (i32.const 1))
        (then (memory.copy (local.get $addr) (i32.const 0) (i32.const 8))))
      (if (i32.eq (local.get $op) (i32.const 2))
        (then (drop (i32.atomic.rmw.add (local.get $addr) (i32.const 1)))))
      (if (i32.eq (local.get $op) (i32.const 3))
        (then (i32.store (local.get $addr) (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (i32.atomic.store (i32.const 4) (local.get $i))
      (br $round)))
    (local.get $i)))
```

The same module, binary (base64; wabt 1.0.39, threads enabled):

```
AGFzbQEAAAABDAJgAX8Bf2ACf38BfwISAQNlbnYGbWVtb3J5AgMBgIAEAwMCAAEHEwIGd3JpdGVyAAAGcmVhZGVyAAEKxQECRwECfwJAA0AgASAATw0BQQFAAEEQdEHAAGohAiACQcAASA0BQQAgAv4XAgAgAUEBaiEBA0BBBP4QAgAgAUkNAAsMAAsLIAELewEDfwJAA0AgAiAATw0BA0BBAP4QAgAhAyADIARGDQALIAMhBCABRQRAIANBB0EQ/AsACyABQQFGBEAgA0EAQQj8CgAACyABQQJGBEAgA0EB/h4CABoLIAFBA0YEQCADQQE2AgALIAJBAWohAkEEIAL+FwIADAALCyACCw==
```

### Node

`repro.mjs` (the reader on the main thread, the writer in a worker):

```js
// node repro.mjs [op] — op 0: memory.fill, 1: memory.copy, 2: i32.atomic.rmw.add, 3: i32.store
import { Worker } from 'node:worker_threads';
const bytes = Buffer.from('<the base64 above>', 'base64');
const ROUNDS = 20000;
const op = Number(process.argv[2] ?? 0);
const module = new WebAssembly.Module(bytes);
const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
const reader = new WebAssembly.Instance(module, { env: { memory } });
const writer = new Worker(
  `const { workerData: { module, memory }, parentPort } = require('node:worker_threads');
   const writer = new WebAssembly.Instance(module, { env: { memory } });
   parentPort.postMessage('ready');
   writer.exports.writer(${ROUNDS});`,
  { eval: true, workerData: { module, memory } },
);
writer.once('message', () => {
  try {
    console.log(`op ${op}: ${reader.exports.reader(ROUNDS, op)} rounds, no trap`);
  } catch (e) {
    console.log(`op ${op}: ${e.name}: ${e.message} (memory now ${memory.buffer.byteLength / 65536} pages)`);
  }
  writer.terminate();
});
```

`node repro.mjs 0` (and 1, 2) prints `RuntimeError: memory access out of bounds (memory now 2
pages)`: the first round traps. `node repro.mjs 3` prints `20000 rounds, no trap`.

### Chrome

`repro.html`, served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (both threads in dedicated workers):

```html
<!doctype html>
<!-- Serve with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp. -->
<pre id="out"></pre>
<script>
const bytes = Uint8Array.from(atob('<the base64 above>'), (c) => c.charCodeAt(0));
const ROUNDS = 20000;
const writerSource = `onmessage = ({ data: { module, memory, rounds } }) => {
  const writer = new WebAssembly.Instance(module, { env: { memory } });
  postMessage('ready');
  writer.exports.writer(rounds);
};`;
// The reader runs in a worker too: the page's own thread cannot spin.
const readerSource = `onmessage = ({ data: { module, memory, rounds, op } }) => {
  const reader = new WebAssembly.Instance(module, { env: { memory } });
  try { postMessage('op ' + op + ': ' + reader.exports.reader(rounds, op) + ' rounds, no trap'); }
  catch (e) { postMessage('op ' + op + ': ' + e.name + ': ' + e.message); }
};`;
const worker = (src) => new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
(async () => {
  const module = await WebAssembly.compile(bytes);
  for (const op of [0, 1, 2, 3]) {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
    const w = worker(writerSource), r = worker(readerSource);
    await new Promise((resolve) => { w.onmessage = resolve; w.postMessage({ module, memory, rounds: ROUNDS }); });
    const line = await new Promise((resolve) => { r.onmessage = (e) => resolve(e.data); r.postMessage({ module, memory, rounds: ROUNDS, op }); });
    document.getElementById('out').textContent += line + '\n';
    w.terminate(); r.terminate();
  }
  document.title = 'done';
})();
</script>
```

## Results

Each run is 20,000 rounds and ends at the first trap.

| Reader's access | Node 24 runs that trapped | Chrome 153 page loads that trapped |
|---|---|---|
| `memory.fill` (op 0) | 3 of 3, in the first round | 3 of 3 |
| `memory.copy` (op 1) | 3 of 3, in the first round | 3 of 3 |
| `i32.atomic.rmw.add` (op 2) | 3 of 3, in the first round | 2 of 3 |
| `i32.store` (op 3) | 0 of 3 | 0 of 3 |

A variant with a postMessage handshake between rounds (the reader spins on an atomic flag in wasm,
then accesses; 3,000 rounds, counting traps) gives lower rates, and shows `memory.size` too:

| Reader's access | Node 24 traps | Chrome 153 traps |
|---|---|---|
| `i32.load` / `i32.store` | 0 | 0 |
| `memory.fill` | 10 | 45 |
| `memory.copy` | 22 | 31 |
| `i32.atomic.rmw.add` | 21 | 34 |
| `memory.size` smaller than the published address | 11 | 44 |
| `memory.fill` after `memory.grow 0` when `memory.size` is too small | 0 | 0 |

When the reader instead blocks in `memory.atomic.wait32` and is woken by the writer's
`memory.atomic.notify`, neither traps in 2,000 rounds.

## Expected

Every op succeeds, as the plain store does: the reader's access is ordered after the growth by the
atomic it waited on.

## Workaround

Before a bulk memory or atomic operation, compare its end with `memory.size` and run `memory.grow 0`
when it is past it. Sandburg rewrites modules with shared memory to do this
(`src/node-runtime/wasm-grow-guard.ts`).
