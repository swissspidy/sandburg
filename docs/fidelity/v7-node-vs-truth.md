# Fidelity study v7: every framework Sandburg runs, vs ground truth

Run 2026-10-28 at 0403c34, after the speed work in ADRs 0017–0062, on a 4-vCPU (Intel Xeon,
2.1 GHz), 16 GB Linux machine with Node.js 24.22.1 and npm 11, 3 tabs at a time. As in v4–v6 the
answers are compared with the corpus's ground truth (`meta.expected`), not with a reference run.
Data: [`v7-node-vs-truth.json`](v7-node-vs-truth.json) (the cold pass).

The corpus grew from 100 to 232 apps. Apps 000–099 are v1–v6's apps, unchanged except for three
labels (below). Apps 100–231 add 12 apps each for the 11 frameworks the README lists that had no
accuracy figure: SvelteKit 3, Angular 22, Nuxt 4, Astro 7, SolidStart 2, React Router 8, Vue,
Svelte and Lit (each on Vite 8), Express + SQLite with a Vue or a React client (6 each), and plain
static HTML.

## Against ground truth

Cold: **224/232 right**. Warm: **226/232**. Every seeded fault was caught in both passes (93/93).
All 8 wrong answers are false alarms, and all are Sandburg bugs (see "False alarms"). The 100 apps
of v1–v6 were all right in both passes.

| Framework | Apps | Right, cold / warm | False alarms, cold / warm | Faults caught | Median run, cold | Median run, warm |
|---|---|---|---|---|---|---|
| Vite, vanilla | 33 | **33** / 33 | 0 / 0 | 9/9 | 3.9 s | 3.9 s |
| Vite + React | 34 | **34** / 34 | 0 / 0 | 8/8 | 12.6 s | 4.4 s |
| Next.js 15 | 33 | **33** / 33 | 0 / 0 | 10/10 | 11.9 s | 11.0 s |
| SvelteKit 3 | 12 | **12** / 12 | 0 / 0 | 6/6 | 11.3 s | 10.3 s |
| Angular 22 | 12 | **11** / 12 | 1 / 0 | 7/7 | 7.5 s | 10.1 s |
| Nuxt 4 | 12 | **12** / 12 | 0 / 0 | 6/6 | 22.3 s | 14.5 s |
| Astro 7 | 12 | **12** / 12 | 0 / 0 | 6/6 | 7.4 s | 10.3 s |
| SolidStart 2 | 12 | **11** / 12 | 1 / 0 | 6/6 | 11.1 s | 9.6 s |
| React Router 8 | 12 | **12** / 12 | 0 / 0 | 6/6 | 8.7 s | 7.3 s |
| Vue (Vite) | 12 | **12** / 12 | 0 / 0 | 6/6 | 3.3 s | 6.3 s |
| Svelte (Vite) | 12 | **12** / 12 | 0 / 0 | 6/6 | 9.5 s | 5.1 s |
| Lit (Vite) | 12 | **6** / 6 | 6 / 6 | 6/6 | 240.8 s | 240.8 s |
| Express + SQLite | 12 | **12** / 12 | 0 / 0 | 6/6 | 4.9 s | 6.6 s |
| Static HTML | 12 | **12** / 12 | 0 / 0 | 5/5 | 2.9 s | 3.2 s |
| **v1–v6 apps** | 100 | **100** / 100 | 0 / 0 | 27/27 | 10.2 s | 5.0 s |
| **v7 apps** | 132 | **124** / 126 | 8 / 6 | 66/66 | 9.3 s | 9.3 s |
| **All** | 232 | **224** / 226 | 8 / 6 | 93/93 | 9.6 s | 8.2 s |

**Lit's number is not a measure of Lit support.** Every Lit app that renders timed out (below). Its
6 right answers are the 6 faulty apps, and two of those (the logic bugs, 174 and 196) were "caught"
only by the same timeout.

On v6's 100 apps the answer is now 100/100: the three apps v6 missed (054, 078, 084) were
mislabelled, and their labels are fixed (below). Under v6's labels, v7 gets the same 97/100 as
v1–v6.

## False alarms (Sandburg bugs)

Not fixed in this study; each is a separate fix.

| Apps | Expected | Got | Passes | Root cause (best guess) |
|---|---|---|---|---|
| 130, 141, 152, 185, 218, 229 (Lit) | pass | error, `timeout: phase-deadline` after 240 s in `ready` | cold and warm | The ready check (`waitForRender`, `src/orchestrator/app-ready.ts`) looks for content in `#root`, `#app` or `#__next`, else `document.body.innerText`. A Lit app whose root element (`<app-root>`) renders only into its shadow root has no light-DOM text, so it is never "rendered". `fixtures/lit-vite` passes only because its `<h1>` is slotted light DOM. Real npm with the same checks passes all six. |
| 134 (Angular) | pass | error, `timeout: phase-deadline` after 240 s in `ready` | cold only | Angular's dev server pre-bundles dependencies with Vite, and rolldown's WebAssembly build crashed (`Error during dependency optimization: … memory access out of bounds`). The run then waited out the ready deadline instead of failing fast on that page error. The same app passed in the warm pass and in an earlier smoke run, so the crash is intermittent. |
| 214 (SolidStart) | pass | failed, `blocking-check-failed` (converter: "32.0 °F", expected "212.0 °F") | cold only | The first check typed into the server-rendered input before Solid had hydrated it, and the input never reached the handler. `src/host/settle.ts` does not wait for Solid's hydration: it relies on Solid replaying events recorded before hydration, which covers clicks but evidently not this `fill()` (`input` event). |

## Misses

None. Every app expected to fail failed, in both passes.

## Mislabelled apps

054, 078 and 084 (Vite + React, `undeclared-import`) import `nanoid` without declaring it. npm
hoists `nanoid` from Vite's own dependencies (postcss), so the import resolves and the apps work:
the Docker reference showed this in v1 and v2 ([ADR 0004](../adr/0004-docker-reference-and-fidelity-study.md),
"Phantom dependencies"), and v3–v6 counted it as a miss. Their label is now `pass`, set by the
generator. Only `meta.json` and `_corpus.json` changed for these apps; their code did not. The new
apps' undeclared import is `dayjs`, which no framework here installs.

## Fault diagnosis

The answers are right, but some faults on the new frameworks were found slowly or classified
`unknown`. The same in both passes:

| Apps | Fault | Result | Why |
|---|---|---|---|
| 157, 190, 212 (Nuxt) | syntax, undeclared import, crash | caught after the 240 s ready deadline (190 as `undeclared-import`, the others as `timeout`) | `nuxt dev` answers 503 with its loading page, then 500 with the error. The ready phase keeps treating the page as still loading, so it waits out its deadline. |
| 148, 203 (SolidStart) | syntax, undeclared import | `timeout` after 240 s | The page stays blank, with no page error or console error to fail fast on. |
| 103 (Astro), 137 (SolidStart), 222 (Angular) | crash | `unknown: unmatched` | Astro and SolidStart answer the server render's error with a 500 page, and Angular logs the error with `console.error` instead of throwing. No classifier rule matches either. |
| 143, 209, 220 (static); 147, 169 (Astro); 166, 177, 221 (SvelteKit); 193 (React Router) | crash, syntax, undeclared import | caught after 36–108 s, as `blocking-check-failed` or by their own rule | The page renders (a static `<h1>`, or a server-rendered shell), and the fault shows up only once the checks run. |

In the v1–v6 apps every fault is classified by its own rule, as in v6: `blocking-check-failed`
(16 logic), `app-error-before-ready` (5 crash), `compile-error` (4 syntax), `unresolvable-dependency`
(2 bad-version).

## Ground truth for the new apps

The new apps reuse the corpus's features (counter, todo, search, tabs, form, modal, persistence,
converter, fetched data; plus date-fns dates everywhere but static, and zustand and lucide-react in
the React apps), written in each framework's own style (`scripts/corpus/components.ts`). Each runs
the same checks as before and has the same seeded bugs. The scaffolds (`scripts/corpus/stacks.ts`)
follow each framework's starter, as in `fixtures/`, with framework packages pinned to their
2026-10-28 versions. Fetched data comes from each framework's own server route: SvelteKit `+server.ts`,
Nuxt `server/api`, an Astro endpoint, a SolidStart API route, a React Router resource route, and
Express reading SQLite. Elsewhere it comes from `public/`.

Each framework has the same 12 faults in a shuffled order: 5 none, 2 logic, and one each of crash,
undeclared import, bad version, syntax and type error. Static HTML has no package.json and no
TypeScript, so it has 7 none instead. That makes the new apps half faulty, against a third in
v1–v6, so that every fault is tried on every framework. The labels follow v1–v6's rule, with one
exception: Angular type-checks as it serves, so its type-error app is expected to fail.

The labels were checked against real npm before the study. Every app was installed with
`npm install` and started with its own dev script on this machine's Node.js 24 (a throwaway harness,
not part of Sandburg), then checked with the same checks:

- 220 of 232 apps matched their label at once, including the Angular type error and the three
  relabelled apps.
- 2 Astro apps failed only because Astro 7 starts `astro dev` as a background daemon when it detects
  a coding agent's environment. They matched once those variables were unset.
- 1 SolidStart, 5 Nuxt and 4 SvelteKit apps failed the first interactive check, because the harness
  clicked before the page hydrated. They matched when their checks were run with plain Playwright
  after the page had loaded and settled.

Docker was available, but the Docker reference runs only Next.js, Angular and Vite dev servers, so
it could not check most of the new frameworks.

## Time

| | v6, 100 apps | v7, 232 apps |
|---|---|---|
| Wall time, cold | 533 s | **1,776 s** |
| Wall time, warm | 289 s | **1,497 s** |
| Run time summed over runs, cold / warm | not reported / 856 s | 6,147 s / 5,384 s |
| Of which runs that hit the 240 s deadline, cold / warm | none | 3,381 s (14 runs) / 3,134 s (13 runs) |
| Median, v1–v6 apps, cold / warm | 13.2 s / 6.5 s | **10.2 s** / **5.0 s** |
| Median, Vite + React, cold / warm | 16.1 s / 5.9 s | **12.6 s** / **4.4 s** |
| Median, Next.js, cold / warm | 14.4 s / 13.0 s | **11.9 s** / **11.0 s** |
| Checks, summed over runs, cold | 184 s | 1,185 s (275 s for the v1–v6 apps) |

- The cold pass starts from empty Sandburg stores (`.sandburg` removed). npm's download cache was
  warm, as in v5 and v6, from the label checks above. Its wall time includes the warm-up of the
  Vite, Vite + React and Next.js stacks. The warm pass runs the same 232 apps again on the same
  stores. It also schedules the apps that were slowest in the cold pass first, which puts the 240 s
  timeouts side by side at its start.
- **Runs that hit the 240 s ready deadline account for more than half the machine time**: the 8 Lit
  apps, 3 Nuxt and 2 SolidStart faults, and the Angular false alarm (cold only). Without them, the
  232 apps took about 2,800 s cold and 2,250 s warm of run time, at 3 at a time.
- On v6's 100 apps, cold medians are 20–25% lower than v6's, and warm medians 15–25% lower. These
  passes also ran the new frameworks alongside, so they are not like-for-like with v6's batches.
  The checks phase of those 100 apps is longer than in v6 (275 s against 184 s cold), with the
  same answers.
- Warm medians for Vue, Astro and Angular are higher than cold, most likely a scheduling effect: the
  warm pass ran most of them while the Lit, Nuxt and SolidStart timeouts held the other tabs.

## Reproduce

```sh
node scripts/corpus/generate.ts corpus 232 1
rm -rf .sandburg
node bin/sandburg.js batch corpus --parallel 3 --out .sandburg/study-cold   # cold
node bin/sandburg.js batch corpus --parallel 3 --out .sandburg/study-warm   # warm
```

Each batch's `summary.json` (path printed at the end) has every run's status and time. Compare each
status with `corpus/<app>/meta.json`'s `expected`. These runs were made as root with
`SANDBURG_NO_BROWSER_SANDBOX=1`, `SANDBURG_CHROMIUM` set to the pre-installed Chromium for
Playwright 1.64.1, and coding-agent environment variables unset.
