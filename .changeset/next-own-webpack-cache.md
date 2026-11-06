---
"sandburg": patch
---

A Next.js app whose next.config gives webpack another cache version than Sandburg's shared seed (a `webpack` function, rewrites, a `basePath`, …) keeps a webpack cache of its own, which its later runs start from. Before, webpack started empty in every run of such an app: a warm run of the App Router fixture with a `webpack` function took about 6.6 s, and takes about 4.3 s now, as one without. Apps the seed fits are unchanged. The app's own cache is keyed by its files, as its other dev caches are: a run after an edit starts from the seed again and keeps a new one.
