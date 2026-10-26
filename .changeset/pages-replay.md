---
"sandburg": patch
---

An app page can run a function its dev server sends it as source text when that function's code was compiled by the Node.js runtime: since the runtime's async functions stay native, their awaits call a helper of the runtime's, which app pages now have too (a pass-through). @nuxt/cli 4 sends its loading screen's client that way; an app opened while Nuxt was still starting stayed on "compiling the first request". The demo site's build records the installed files a demo asks for as a demo asks for them, not as the runtime's read-aheads over its file channel answer them.
