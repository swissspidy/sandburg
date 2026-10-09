# sandburg

## 0.2.0

### Minor Changes

- [#22](https://github.com/swissspidy/sandburg/pull/22) [`1228556`](https://github.com/swissspidy/sandburg/commit/1228556192150baf6c12202d72f351c4cc1ab9f7) Thanks [@swissspidy](https://github.com/swissspidy)! - `sandburg run --checks-in page` runs a checks file's code in the sandbox tab instead of Sandburg's Node process, for checks someone else wrote, such as a coding agent. Checks get the same `app`, `expect` and `appUrl`, with Playwright's locators (resolved by ivya), actions and assertions. The library exports `loadPageChecks`, and `RunOptions` takes `checksIn`.
