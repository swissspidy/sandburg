---
'sandburg': patch
---

`esbuild.build()` and `esbuild.context()` resolve relative entry points and output paths against the working directory, as under Node: `absWorkingDir` defaults to `process.cwd()`, not esbuild-wasm's `/`. A build with `entryPoints: ['src/server/index.ts']` and `packages: 'external'` no longer fails with "The entry point … cannot be marked as external".
