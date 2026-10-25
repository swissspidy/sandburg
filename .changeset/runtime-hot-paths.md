---
"sandburg": patch
---

A faster runtime: node:crypto's MD5, SHA-1 and SHA-2 hashes and HMACs (and random bytes) are the runtime's own (2-5x faster than crypto-browserify's for MD5, SHA-1 and SHA-256), and crypto-browserify loads only when a program uses one of its other members; node:zlib loads its JavaScript port only when a program uses it (Vite requires zlib and does not use it in dev); long strings are encoded to UTF-8 with `encodeInto` (~3x faster); worker threads answer reads of unchanged project files from their snapshot instead of waiting for their parent; UTF-16 writes store a code unit at a time. An unknown hash algorithm now throws Node's `Digest method not supported`.
