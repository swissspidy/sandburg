---
"sandburg": patch
---

SvelteKit apps on Svelte 5.59 and later are hydrated before their functional checks start. Svelte 5.59 marks every element as soon as its runtime loads, before it hydrates, so the checks could start on server-rendered HTML whose buttons did nothing yet: a check's first click was lost, and a correct app failed (a counter clicked twice showed "Count: 1"). Sandburg now waits for Svelte's handlers or bindings on the page's elements, up to 10 s as before; a page without buttons, inputs or other controls is ready once its servers are quiet.
