# Sandburg fidelity report

Generated 2026-09-29T15:39:44.576Z. Browser runtime: almostnode 0.2.14. Reference: docker node:22-slim.

## Agreement (pass/fail per app)

| Framework | Apps | Agreement | Both pass | Both fail | Browser stricter | Browser lenient |
|---|---|---|---|---|---|---|
| nextjs | 33 | **97.0%** | 23 | 9 | 0 | 1 |
| vite-react | 34 | **64.7%** | 14 | 8 | 12 | 0 |
| vite-vanilla | 33 | **69.7%** | 15 | 8 | 9 | 1 |
| **All** | 100 | **77.0%** | 52 | 25 | 21 | 2 |

"Browser stricter": the browser run failed and the reference passed (a false alarm if the browser is used as a pre-filter). "Browser lenient": the browser run passed and the reference failed (a missed failure).

## Against ground truth

For 100 apps with a known expected outcome (seeded faults), the browser run was right in **80.0%** of apps and the Docker reference in **97.0%**.

## Disagreements by cause

| Cause | Apps |
|---|---|
| `blocking-check-failed` | 18 |
| `undeclared-import` | 3 |
| `lenient:bad-version` | 2 |

| App | Direction | Cause | Browser failure | Reference failure |
|---|---|---|---|---|
| 003-vite-react | browser-stricter | `blocking-check-failed` | checks: router |  |
| 006-vite-react | browser-stricter | `blocking-check-failed` | checks: router, tailwind-modal |  |
| 011-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 012-vite-react | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 014-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 020-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 035-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 036-vite-react | browser-stricter | `blocking-check-failed` | checks: router |  |
| 037-next-app | browser-lenient | `lenient:bad-version` |  | npm install failed: docker exec sandburg-ref-mumu72a6-1ea277 npm exited with 1 |
| 038-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 039-vite-react | browser-stricter | `blocking-check-failed` | checks: router, fetch |  |
| 045-vite-react | browser-stricter | `blocking-check-failed` | checks: router, tailwind-modal |  |
| 054-vite-react | browser-stricter | `undeclared-import` | imports undeclared package "nanoid" |  |
| 056-vite-vanilla | browser-lenient | `lenient:bad-version` |  | npm install failed: docker exec sandburg-ref-mumu8yjo-2c4026 npm exited with 1 |
| 059-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 066-vite-react | browser-stricter | `blocking-check-failed` | checks: fetch, tailwind-modal |  |
| 069-vite-react | browser-stricter | `blocking-check-failed` | checks: router |  |
| 071-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 077-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 078-vite-react | browser-stricter | `undeclared-import` | imports undeclared package "nanoid" |  |
| 084-vite-react | browser-stricter | `undeclared-import` | imports undeclared package "nanoid" |  |
| 095-vite-vanilla | browser-stricter | `blocking-check-failed` | checks: fetch |  |
| 099-vite-react | browser-stricter | `blocking-check-failed` | checks: fetch |  |

## Time and cost per run

Measured on one 4-vCPU machine. Cost assumes $0.0504/vCPU-hour and charges the whole machine for the batch's wall time.

| | Parallel | Median run | p90 run | Batch wall time | Machine time per app | Cost per app |
|---|---|---|---|---|---|---|
| Browser (almostnode 0.2.14) | 4 | 5.1 s | 13.0 s | 170.7 s | 1.7 s | $0.000096 |
| Reference (docker node:22-slim) | 3 | 12.4 s | 29.9 s | 515.5 s | 5.2 s | $0.000289 |
