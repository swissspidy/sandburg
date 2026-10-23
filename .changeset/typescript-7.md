---
"sandburg": minor
---

Next.js apps on TypeScript 7 run in the browser runtime. TypeScript 7's `tsc` is native code: in the runtime, `tsc --showConfig` (what `next dev` asks for) is answered in JavaScript, and type checks run tsrs, a Rust port of TypeScript 7, as WebAssembly (`@tsrs/wasm`). An extensionless module in `node_modules`, such as a package's `bin` script, now loads as JavaScript, as Node loads it.
