# Sandburg fidelity report

Generated 2026-09-29T15:59:33.916Z. Browser runtime: almostnode 0.2.14. Reference: docker node:22-slim.

## Agreement (pass/fail per app)

| Framework | Apps | Agreement | Both pass | Both fail | Browser stricter | Browser lenient |
|---|---|---|---|---|---|---|
| nextjs | 33 | **100.0%** | 23 | 10 | 0 | 0 |
| vite-react | 34 | **91.2%** | 23 | 8 | 3 | 0 |
| vite-vanilla | 33 | **100.0%** | 24 | 9 | 0 | 0 |
| **All** | 100 | **97.0%** | 70 | 27 | 3 | 0 |

"Browser stricter": the browser run failed and the reference passed (a false alarm if the browser is used as a pre-filter). "Browser lenient": the browser run passed and the reference failed (a missed failure).

## Against ground truth

For 100 apps with a known expected outcome (seeded faults), the browser run was right in **100.0%** of apps and the Docker reference in **97.0%**.

## Disagreements by cause

| Cause | Apps |
|---|---|
| `undeclared-import` | 3 |

| App | Direction | Cause | Browser failure | Reference failure |
|---|---|---|---|---|
| 054-vite-react | browser-stricter | `undeclared-import` | imports undeclared package "nanoid" |  |
| 078-vite-react | browser-stricter | `undeclared-import` | imports undeclared package "nanoid" |  |
| 084-vite-react | browser-stricter | `undeclared-import` | imports undeclared package "nanoid" |  |

## Time and cost per run

Measured on one 4-vCPU machine. Cost assumes $0.0504/vCPU-hour and charges the whole machine for the batch's wall time.

| | Parallel | Median run | p90 run | Batch wall time | Machine time per app | Cost per app |
|---|---|---|---|---|---|---|
| Browser (almostnode 0.2.14) | 4 | 5.3 s | 12.6 s | 175.8 s | 1.8 s | $0.000098 |
| Reference (docker node:22-slim) | 3 | 12.0 s | 28.4 s | 487.1 s | 4.9 s | $0.000273 |
