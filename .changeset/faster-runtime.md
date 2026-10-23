---
"sandburg": minor
---

Faster runs, warm ones above all. Large compiled code is asked for by its digest before it is sent (`GET /__sandburg/compiled/<sha256>`), code goes to the host compiler as a Blob, preload bundles are built when their URL is issued, hold installed files up to 10 MB and name larger ones for the runtime to download on the side, base64 is native where the browser has it, and the Next.js 16 seed keeps webpack's cache from `.next/dev/cache`, where Next.js 16 writes it. A `.js` file with ES module syntax in a `"type": "commonjs"` scope now fails as it does in Node, instead of loading as a module.
