# ADR 0025: The runtime's hot path

- Status: Accepted
- Date: 2026-10-23

## Context

A CPU profile and host trace of warm `fixtures/next-app-router` runs (scripts/profile.ts, ADR 0017)
put most of a run's time in a few places:

- **The Next.js seed did nothing.** Next.js 16 builds into `.next/dev`, so the seed run (ADR 0014)
  waited 40 s for webpack packs under `.next/cache` that never came, stored nothing, and every app
  compiled from an empty webpack cache.
- **Compiling next dev's 8 MB vendor chunk**, the same in every run, which the host had already
  compiled: the runtime sent it again each time, as a string body (~0.85 s before the host saw it),
  after hashing it with FNV-1a in JavaScript.
- **Synchronous file requests** the preload bundle should have answered: the runtime waited for ten
  single requests before it fetched the bundle, the bundle left out files over 2 MB (webpack's
  `bundle5.js`), and the host built a new bundle on the request (~1.8 s for next dev).
- **JavaScript loops** in place of native code: the buffer polyfill's base64 (0.22 s), path
  normalization (70 ms), and ES module detection in `.next/dev`, a `"type": "commonjs"` scope where
  Node does none (0.26 s).

## Decision

- **The Next.js seed keeps `.next/dev/cache` on Next.js 16**, and keeps it once its files stop
  changing, not only their total size (webpack writes each pack under a temporary name and renames it).
- **Compiled code is keyed by the code**, not a JavaScript hash, in the runtime's cache, and goes to
  the host compiler as a Blob.
- **Code of 256 KB or more is asked for by digest first**: `GET /__sandburg/compiled/<sha256>`, the
  key the host's compile cache already uses; only a miss is sent. A small helper worker computes the
  digest with WebCrypto (the runtime waits on shared memory), and digests large `.js` files as the
  program writes them, so the digest is ready when they are required. The host computed the key
  over what it compiled, so one run cannot plant compiled code for another; the route answers only
  for code the host compiled.
- **Preload bundles**: fetched with a program's first installed file; built when the run's install
  is handed to it, with the last four installs' bundles kept in memory; files up to 10 MB included
  (the limit is part of the bundle's hash). Larger files (WebAssembly binaries such as swc's 30 MB)
  are named, and the helper downloads them into shared memory beside the run; a read waits for what
  is left of the download.
- **Native code where there is some**: `Uint8Array.prototype.toBase64` for base64 encoding, and
  paths that are normal already are returned as they are.
- **No syntax detection in a `"type": "commonjs"` scope**, as in Node.

## Consequences

- Warm `fixtures/next-app-router` runs take about half as long; with ADRs 0026 and 0027, 11.3 s →
  5.9 s on an idle 4-core machine, and a cold one, which now stores a seed, 89 s → 38 s. Each
  change's own measurement is in its commit message.
- **A `.js` file with ES module syntax under `"type": "commonjs"` fails**, as in Node, where it loaded
  before.
- The first compile of large code after the host starts costs a digest and one small request.
- The host holds up to four preload bundles in memory.
