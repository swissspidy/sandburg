---
"sandburg": patch
---

Vite (rolldown) apps start again with @napi-rs/wasm-runtime 1.2.6: a WebAssembly binding's install gets the exact @emnapi/core and @emnapi/runtime its wasm-runtime needs (2.0.0-beta.2 for 1.2.6) when the binding pins another (rolldown 1.2.15: 2.0.0-alpha.5), on the host and in the browser install.
