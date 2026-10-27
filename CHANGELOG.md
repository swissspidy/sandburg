# sandburg

## 0.2.0

### Minor Changes

- [#22](https://github.com/swissspidy/sandburg/pull/22) [`1228556`](https://github.com/swissspidy/sandburg/commit/1228556192150baf6c12202d72f351c4cc1ab9f7) Thanks [@swissspidy](https://github.com/swissspidy)! - `sandburg run --checks-in page` runs a checks file's code in the sandbox tab instead of Sandburg's Node process, for checks someone else wrote, such as a coding agent. Checks get the same `app`, `expect` and `appUrl`, with Playwright's locators (resolved by ivya), actions and assertions. The library exports `loadPageChecks`, and `RunOptions` takes `checksIn`.

## 0.1.0

### Minor Changes

- [#18](https://github.com/swissspidy/sandburg/pull/18) [`2e97548`](https://github.com/swissspidy/sandburg/commit/2e975488abe7c74df15c2f2a34f2865c1b690a73) Thanks [@swissspidy](https://github.com/swissspidy)! - Harbor without Docker: a Sandburg environment, 30 two-step app-gen tasks, and a thread VFS fix.
- [#17](https://github.com/swissspidy/sandburg/pull/17) [`7b4bc1d`](https://github.com/swissspidy/sandburg/commit/7b4bc1d91fe50d57874583f0ef3c25b5f03cb86d) Thanks [@swissspidy](https://github.com/swissspidy)! - Make Sandburg installable from npm.
- [#16](https://github.com/swissspidy/sandburg/pull/16) [`f281417`](https://github.com/swissspidy/sandburg/commit/f2814170d670de8259497de7999ecee62e3dec96) Thanks [@swissspidy](https://github.com/swissspidy)! - Next.js 16.4.0.
- [#14](https://github.com/swissspidy/sandburg/pull/14) [`d57b34b`](https://github.com/swissspidy/sandburg/commit/d57b34b903ea1876de9ed2e79c284b925269b5c4) Thanks [@swissspidy](https://github.com/swissspidy)! - App-gen eval: a follow-up request per task, six stacks; Sandburg fixes it found.
- [#13](https://github.com/swissspidy/sandburg/pull/13) [`3df0562`](https://github.com/swissspidy/sandburg/commit/3df0562e50da8869d48471d73937e13adc58a84d) Thanks [@swissspidy](https://github.com/swissspidy)! - Demos on GitHub Pages: dev servers see localhost; Nuxt 4.6 (@nuxt/cli 4) runs again.
- [#12](https://github.com/swissspidy/sandburg/pull/12) [`e4f7b74`](https://github.com/swissspidy/sandburg/commit/e4f7b74078a61ffed4d2d808b0789824a293fe27) Thanks [@swissspidy](https://github.com/swissspidy)! - App-generation eval: models × stacks × tasks, run and checked in Sandburg.
- [#11](https://github.com/swissspidy/sandburg/pull/11) [`15c608e`](https://github.com/swissspidy/sandburg/commit/15c608eada78621c2ff1de6039faf28a7fbb8f9f) Thanks [@swissspidy](https://github.com/swissspidy)! - Generator: nine stacks, each with a backend and SQLite.
- [#10](https://github.com/swissspidy/sandburg/pull/10) [`d90cffb`](https://github.com/swissspidy/sandburg/commit/d90cffba647298b93f4250696a0f0cba2262a967) Thanks [@swissspidy](https://github.com/swissspidy)! - Demo site: cross-origin isolation in Safari and on iOS (require-corp).
- [#9](https://github.com/swissspidy/sandburg/pull/9) [`91854c1`](https://github.com/swissspidy/sandburg/commit/91854c1492532ac0ef3dfd7a29e1d36e642481ab) Thanks [@swissspidy](https://github.com/swissspidy)! - Generate an app with an LLM on the demo site, and run it in the tab.
- [#8](https://github.com/swissspidy/sandburg/pull/8) [`3749569`](https://github.com/swissspidy/sandburg/commit/3749569a413205d0043f0c15c6f6e48183fcb33f) Thanks [@swissspidy](https://github.com/swissspidy)! - Fail fast on a crashed WebAssembly thread; batch test independent of npm's cache; installs without dependencies.
- [#7](https://github.com/swissspidy/sandburg/pull/7) [`2f43d71`](https://github.com/swissspidy/sandburg/commit/2f43d714c94b75693be945a9e3dc8dbea5ce0552) Thanks [@swissspidy](https://github.com/swissspidy)! - Browser install: compile in the page; the host serves static files only.
- [#4](https://github.com/swissspidy/sandburg/pull/4) [`117f54a`](https://github.com/swissspidy/sandburg/commit/117f54ae14c497c09501240de0e924b13c44f266) Thanks [@swissspidy](https://github.com/swissspidy)! - npm install in the browser (opt-in), latest framework versions, faster runtime, CI.
- [#3](https://github.com/swissspidy/sandburg/pull/3) [`8d440f6`](https://github.com/swissspidy/sandburg/commit/8d440f68635eca46bb4ac8ac5efdf196eba6047b) Thanks [@swissspidy](https://github.com/swissspidy)! - One node runtime for every project, 2× faster runs, and live demos on GitHub Pages.
- [#2](https://github.com/swissspidy/sandburg/pull/2) [`48e2f5e`](https://github.com/swissspidy/sandburg/commit/48e2f5e5bdf4f286d9b18e42a68d8b8078430126) Thanks [@swissspidy](https://github.com/swissspidy)! - SolidStart, Tailwind v4 on the node runtime; remove almostnode and Nodebox; --runtime auto.
- [#1](https://github.com/swissspidy/sandburg/pull/1) [`e9ec162`](https://github.com/swissspidy/sandburg/commit/e9ec1621b04fd4cc6d5270e84bd0559c11b657de) Thanks [@swissspidy](https://github.com/swissspidy)! - Add ADR 0001 and milestone 1 spike: Vite + React in almostnode.
