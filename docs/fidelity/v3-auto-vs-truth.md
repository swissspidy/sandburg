# Fidelity study v3: `--runtime auto` vs ground truth

Run 2026-09-30 on one 4-vCPU machine, 3 tabs at a time, with cold npm installs. Browser runtime:
`--runtime auto` ([ADR 0013](../adr/0013-runtime-consolidation.md)): the esbuild adapter for the Vite
apps, the node runtime (real `next dev`) for the Next.js apps. Docker was not available, so this study
compares against the corpus's ground truth only (`meta.expected`), not against the Docker reference.
Data: [`v3-auto-vs-truth.json`](v3-auto-vs-truth.json).

## Against ground truth

| Framework | Runtime | Apps | Right | Expected pass → passed | Expected fail → failed | Median run | p90 run |
|---|---|---|---|---|---|---|---|
| vite-vanilla | esbuild | 33 | **33** | 24/24 | 9/9 | 2.7 s | 7.7 s |
| vite-react | esbuild | 34 | **31** | 23/23 | 8/11 | 13.4 s | 24.0 s |
| nextjs | node | 33 | **33** | 23/23 | 10/10 | 38.4 s | 59.7 s |
| **All** | | 100 | **97** | 70/70 | 27/30 | 13.4 s | 42.2 s |

No false alarms: every app expected to pass passed.

The three misses (054, 078, 084: `undeclared-import`) import `nanoid` without declaring it. npm hoists
`nanoid` (a dependency of another package), so the import resolves under real Node too: the Docker
reference passed them in v1 and v2, and the fidelity README already records these labels as wrong.
Both runtimes now install dependencies with npm, as the reference does, so they agree with it here.

## Classification of the caught faults

Of the 27 failing apps that were caught, 24 were classified `app-bug`. The other three were `unknown`
and prompted two rules, added after the run, that classify them as app bugs
(`src/classify.ts`, unit tests use their messages):

- `unresolvable-dependency`: npm cannot find a declared version (`bad-version` faults, 037 and 056).
- `app-error-before-ready` now recognises webpack's `webpack-internal:///(…)/./pages/index.tsx` frames
  as project code (a `crash` fault in a Pages Router app, 064).

## What the study found

Two runtime gaps showed up in the first run, and both are fixed:

- Tailwind CSS v4 in Next.js needs lightningcss and Tailwind's oxide scanner. lightningcss now uses
  its WebAssembly build. Threads that start while their parent is blocked now come from runtimes booted
  in advance.
- Pages Router server chunks were taken for ES modules. The loader now detects ES modules as Node
  does: a `.js` file outside a `"type"` package is an ES module only if it does not parse as CommonJS.

## Compared with almostnode (v1, v2)

v2 (almostnode, adapter fixed after v1 on this same corpus) was right on 100/100 against ground truth,
with a median run of 5.3 s. It is fast because it never runs `next dev`, and so it cannot run
server-only code. Its three phantom-dependency apps were "right" against the corpus labels but
disagreed with the Docker reference. v3 is slower for Next.js apps (38 s median, cold installs
included) but runs the real tools.
