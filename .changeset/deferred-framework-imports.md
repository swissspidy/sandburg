---
"sandburg": patch
---

Faster Astro and Nuxt starts: modules their dev servers loaded for features a project may not use (Astro's svgo optimizer, fonts resolvers and MDX compiler; Nuxt's Babel for Vue JSX, Nitro's archiver, node-forge and youch) are loaded when first used.
