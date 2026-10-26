Next.js' fork of webpack's `EvalSourceMapDevToolPlugin`, as published (MIT, from the `next` package:
`dist/build/webpack/plugins/eval-source-map-dev-tool-plugin.js` as `<version>-cjs.js.txt`, and its
`dist/esm/…` twin as `<version>-esm.js.txt`), for `test/unit/source-patches.test.ts`: Sandburg's
patch of it must apply to each in full, or not at all.
