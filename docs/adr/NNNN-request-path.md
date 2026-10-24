# ADR NNNN: The app's requests through the service worker

- Status: Accepted
- Date: 2026-10-24

## Context

An app's page, scripts, styles and API calls go from its frame to the sandbox's service worker
(`src/adapters/node/sw.js`), over a MessagePort to the host page (`sw-bridge.ts`, `process.ts`), to
the runtime worker's virtual HTTP server (`worker.ts`, `builtins/http.ts`), and back the same way.
Each response was three or more messages each way (start, a chunk per write, end), and each request
had a MessageChannel of its own. We measured where a request's time goes (warm runs, a 4-core
machine), with the app frame's resource timing, a `Server-Timing` entry the runtime added for the
time from dispatch to its first byte, user-timing marks in the service worker and the runtime, and
Chromium traces:

- **The bridge is cheap; the server is not.** In a Vite page the time to the response's first byte
  inside the runtime is most of each request: `lit-vite`'s `/@vite/client` 102 ms, `index.css` 79 ms,
  `my-element.ts` 47 ms, against a few ms each between the service worker and the server. SvelteKit's
  first page is rendered on the server in ~1.4 s before any module is requested; Astro's in ~2.6 s.
  Most of the runtime's time in that window is the dev server's own work (rolldown's string passing
  to WebAssembly, `decode`/`encode`, Vite's plugins).
- **A round trip from the service worker through the runtime and back took ~0.5 ms** for a small
  static file (marks at each hop). The service worker's own JavaScript per request was ~0.16-0.24 ms.
- **What a chain of imports waits for is Chromium between hops.** For 60 modules that each import the
  next (a static page in the runtime's static file server), a hop took ~4 ms: ~0.5 ms in the bridge,
  the rest the response reaching the frame, parsing, compiling and the next request reaching the
  service worker. Served by a plain HTTP server, without a service worker, the same chain took
  ~2.2 ms a hop.
- **A burst is bounded by the service worker thread.** 300 modules imported by one: the service
  worker's thread was 93% busy during the burst, most of it Chromium's own work per fetch event and
  per response body, not the worker's JavaScript. A service worker that answered each module itself,
  without the runtime, took as long (~300 ms); a plain HTTP server ~200 ms.
- **Messages per request**: a response that a dev server ends in one call (`res.end(code)`, most of
  them) was a start, a chunk and an end from the runtime to the page, the same three from the page to
  the service worker, plus a MessageChannel created, transferred and closed per request: each a task
  on the page's main thread (which the app's frame shares) and on the service worker's thread.
- **The WebSocket shim** (`/__sandburg/ws-shim.js`), a parser-blocking script at the top of every app
  page, came from the host through Playwright's request interception: 4-5.5 ms per app document.
- **HTTP caching**: Vite marks pre-bundled dependencies `immutable` and the rest `no-cache` with an
  ETag. Responses from a service worker never enter the HTTP cache, so a browser cannot revalidate
  them; but within a run few requests repeat (Astro's second page re-requested five modules, each
  answered in 0.3-6 ms), and runs do not share an origin. Not worth a cache of the bridge's own.

## Decision

- **Whole responses in one message.** The runtime holds a response's start and its chunks until the
  end of the task that started it (a message on a native MessageChannel, not a timer); a response
  that has ended by then goes to the page as one `response-full` message (status, headers and the
  body as a transferred ArrayBuffer), and from the page to the service worker as one `full` message.
  A response still going at the end of the task, or whose body passes 1 MB, streams as before from
  there on. Responses of servers in child processes and threads are passed up the same way; a
  loopback request (a dev proxy) gets them as start, chunk and end.
- **One port for every request.** The service worker gives each request an id and sends it on the
  port the page gave it; the page's replies carry the id and go back on that port. No MessageChannel
  per request.
- **The WebSocket shim from the service worker's memory**: fetched when the page hands the service
  worker its port (as the app starts), then answered from memory like the runtime's scripts. The
  static demos already answer it from memory (pages/sw.js).

## Consequences

- Microbenchmarks (static pages in the runtime, warm, interleaved, medians):
  - 60-module import chain: all modules loaded in ~228 ms with whole responses and the shim, ~261 ms
    before (n=6); per request 1.7 vs 2.0 ms. With one port: ~234 ms against ~240 ms (n=6, noise).
  - 300 modules imported at once: 285-330 ms against 337-370 ms (whole responses and the shim, n=4);
    one port: ~286 ms against ~318 ms (n=4).
  - The shim: 1.9-3.1 ms per app document instead of 4-5.5 ms.
- Fixtures: see the branch's benchmark below (BENCH).
- **Behaviour**: none an app can see. Responses are the same bytes, status and headers; a response
  that ends in one task reaches the page at the end of that task instead of in pieces during it. The
  app frame's request for `/__sandburg/ws-shim.js` is answered by the service worker (one request
  from the service worker to the host per run instead of one per app document).

## Security

- No new route, socket or cache shared across runs: the service worker, the page and the runtime are
  the sandbox's own, as before. The service worker's request ids are per service worker and only
  index its own requests in flight; the page answers on the port it gave, which only that service
  worker holds.
- The shim cache is per service worker, so per sandbox origin; it holds the file the host serves at
  that origin's `/__sandburg/ws-shim.js`, fetched by the service worker as the page would.
- The runtime holds at most 1 MB of a response's body per response before it streams, so a large or
  endless response does not grow memory beyond what streaming held.

## What did not help

- **A direct channel from the service worker to the runtime worker**, past the host page's main
  thread (a prototype that left cookies out): per request ~0.4 ms less in the import chain, ~150 ms
  less in the CPU profile of the page's main thread over 300 requests, but no change in the burst (bounded by the
  service worker's thread) and none in the fixtures (`vite-react-counter` 2.09 → 2.27 s, `lit-vite`
  1.53 → 1.54 s, `sveltekit-app` 5.26 → 5.22 s, warm, n=3). Doing it fully would move cookies from
  the host page's `document.cookie` to the service worker's `cookieStore`, a change of semantics;
  not worth it for no measured gain.
- **Whole responses as an ArrayBuffer body** (`new Response(buffer)`) instead of a stream enqueued at
  once: Chromium hands a service worker's non-stream body to the frame as a blob, read through the
  browser process (`ServiceWorkerSubresourceLoader::StartBlobReading`), which added latency per
  request. The stream stays.
- **Batching several responses in one message** (with the direct channel): no change; the service
  worker's thread spends its time in Chromium's per-request work, not in message handling.

## Not done

- **Vite's ETags** are a SHA-1 of every response in the runtime's crypto (~8 ms of a Vite page load;
  ADR 0029 already sped up its block copy). Only native hashing would cut it much further.
- **The dev servers' own time per request** (rolldown's string conversions, Vite's transforms on
  first request, SvelteKit's and Astro's server render) is most of a page load; that is the runtime's
  and the frameworks' work (perf-wasm-tools, perf-nextjs), not the bridge's.
