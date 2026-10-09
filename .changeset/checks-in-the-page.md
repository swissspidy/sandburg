---
"sandburg": minor
---

`sandburg run --checks-in page` runs a checks file's code in the sandbox tab instead of Sandburg's Node process, for checks someone else wrote, such as a coding agent. Checks get the same `app`, `expect` and `appUrl`, with Playwright's locators (resolved by ivya), actions and assertions. The library exports `loadPageChecks`, and `RunOptions` takes `checksIn`.
