---
"sandburg": patch
---

A TSX or TypeScript syntax error that Vite 8 reports is an app bug at its file, line and column again with rolldown 1.2.16, whose WebAssembly build heads its code frame with a path relative to the dev server's folder (`src/App.tsx:3:1`) rather than to `/` (`app/src/App.tsx:3:1`). Both are read, as is a frame relative to a folder of the project that a dev script runs in.
