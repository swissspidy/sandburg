---
"sandburg": patch
---

Faster checks: the functional checks start once the app can take input (a server-rendered app that hydrates is waited for beside the screenshot, accessibility snapshot and axe-core, at most 3 s; Solid, React and Nuxt say when input is safe), a web-first assertion that waits is checked every 100 ms beside Playwright's own polls and passes as soon as the page gets there (failures and their messages are unchanged), and a run that starts from a dev server's cache no longer reads it back at the end when it did not change it.
