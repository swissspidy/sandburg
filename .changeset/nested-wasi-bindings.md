---
'sandburg': patch
---

A napi-rs package installed twice in different versions (a project's rolldown 1.2 and Vite 8.4's own rolldown 1.3, nested in `vite`) gets the WebAssembly binding of its own version, as npm places optional dependencies: the nested copy's goes inside it. It loaded the top copy's binding before, and Vite's dependency optimizer failed with `chunk.trackExternalMemory is not a function` (Nuxt 4, Astro 7 with Vite 8.4). Both the host's installer and the in-browser one.
