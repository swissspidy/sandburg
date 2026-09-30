# Fidelity study v4: the node runtime alone vs ground truth

Run 2026-09-30 on one 4-vCPU machine, 3 tabs at a time, with cold npm installs. Browser runtime: the
node runtime for every app ([ADR 0014](../adr/0014-node-runtime-only.md)). The Vite apps run their
own Vite dev server; v3 built them with the esbuild adapter. Docker was not available, so, as in v3,
this compares against the corpus's ground truth (`meta.expected`) only.
Data: [`v4-node-vs-truth.json`](v4-node-vs-truth.json).

## Against ground truth

| Framework | Apps | Right | Expected pass → passed | Expected fail → failed | Median run | p90 run | Median run, warm |
|---|---|---|---|---|---|---|---|
| vite-vanilla | 33 | **33** | 24/24 | 9/9 | 3.9 s | 18.9 s | 3.4 s |
| vite-react | 34 | **31** | 23/23 | 8/11 | 33.0 s | 76.9 s | 9.1 s |
| nextjs | 33 | **33** | 23/23 | 10/10 | 40.4 s | 78.9 s | |
| **All** | 100 | **97** | 70/70 | 27/30 | 28.9 s | 70.0 s | |

No false alarms: every app expected to pass passed. The misses are the same three as in v3 (054, 078,
084: `undeclared-import`). They import `nanoid`, which npm hoists from another package, so they pass
under real Node and in the Docker reference too; their labels are wrong.

"Warm" is a second pass over the Vite apps with the installs and Vite's pre-bundled dependencies kept
from the first. It gave the same result for every app. Cold vite-react runs are slow because
Vite 6 pre-bundles `lucide-react` (thousands of modules) with esbuild's WebAssembly build, in one
thread: 50–60 s of the first run.

## Classification of the caught faults

All 27 caught faults were classified `app-bug`, each by the rule its fault calls for (v3 had three
`unknown` before its follow-up rules):

| Fault | Apps | Rule |
|---|---|---|
| logic | 16 | `blocking-check-failed` |
| crash | 5 | `app-error-before-ready` |
| syntax | 4 | `compile-error` (Vite's report, with the file and line) |
| bad-version | 2 | `unresolvable-dependency` |

## Compared with v3

Same answers on all 100 apps. The Vite apps now run the tools their `package.json` names instead of a
rebuild of them. First runs are slower (vite-react median 33 s against 13.4 s on the esbuild
adapter, both with cold installs); repeat runs of the same app are faster than v3's cold runs.
