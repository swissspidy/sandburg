---
"sandburg": patch
---

Fixes for the false alarms and slow diagnoses of fidelity study v7 ([ADR 0066](https://github.com/swissspidy/sandburg/blob/main/docs/adr/0066-fidelity-v7-fixes.md)):

- An app that renders only into a custom element's shadow root (a Lit app) is ready once its open shadow roots show text; it timed out before.
- The functional checks wait for a SolidStart page to hydrate (every server-rendered element claimed), up to 10 s: a `fill()` before then was lost. A framework that says it has not hydrated yet is waited for up to 10 s, others up to 3 s as before.
- The ready phase fails fast on an error the app reports while its page never finishes loading (Angular's dev server after its dependency optimizer crashed), and on a page that answers 500 after a 503 loading page (Nuxt), instead of waiting out its deadline.
- New classification: `server-render-error` (app-bug) for a page the dev server could not render on the server (Nuxt's request error, an error with a stack through the project's files in Astro's output); `compile-error` for Nuxt's `SyntaxError [VITE_ERROR]`; `app-error-before-ready` for an error the app logged instead of throwing, with a stack through its own code (Angular's ErrorHandler, SolidStart); `signature:wasm-trap` for a WebAssembly trap Vite reported to the page.
