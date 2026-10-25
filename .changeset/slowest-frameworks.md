---
"sandburg": patch
---

Faster meta-framework runs. Nuxt serves its first page as soon as Nitro's worker is ready (it checked every 600 ms), SolidStart's server functions manifest no longer waits a second for more server functions, and SolidStart's router no longer sends a hot update of the app right after the page loads. Rolldown's builtin plugins are no longer called by Vite for hooks they do not have or modules they leave alone. A project's runs keep vite-plugin-solid's Babel compiles (in `node_modules/.vite/sandburg-transforms`) and jiti's cache (`node_modules/.cache/jiti`) for the next run, as they keep Vite's cache.
