# sveltekit-app

A SvelteKit 3 app on Vite 8 (created with `sv create --template minimal --types ts`, then edited):
a page server-rendered with data from `load()`, a counter that shows it hydrated, and a second
route for client navigation. `checks.spec.ts` drives it; the vite-frameworks e2e suite and the
SvelteKit demo on the pages site run it. Shared code is imported through `#lib` (the package.json
`"imports"` field), since SvelteKit 3 has no `$lib`.
