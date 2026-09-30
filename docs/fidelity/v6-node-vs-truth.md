# Fidelity study v6: fail-fast checks, Vite seeds and warm-ups, vs ground truth

Run 2026-09-30 on the same 4-vCPU machine as v4 and v5, 3 tabs at a time, after the changes in
[ADR 0016](../adr/0016-faster-batches.md):

- assertions that stop waiting once the app is idle;
- Vite pre-bundling seeds shared by apps with the same packages and settings;
- warm-ups of common stacks before a batch.

The cold pass starts from empty Sandburg stores, and npm's download cache was warm, as in v5. Its
wall time includes the warm-up. The warm pass runs the same 100 apps again, and its warm-up did
nothing. Data: [`v6-node-vs-truth.json`](v6-node-vs-truth.json) (the cold pass).

## Against ground truth

Both passes gave the same answers as v5 on every app: **97/100 right, no false alarms**. The misses
are the same three mislabelled apps (054, 078 and 084, where `nanoid` is hoisted by npm). All 27
caught faults are classified `app-bug`, by the same rules.

## Time

| | v5, cold | v6, cold | v5, warm | v6, warm |
|---|---|---|---|---|
| Wall time, 100 apps | 613 s | **533 s** | 361 s | **289 s** |
| Median, vite-vanilla | 3.7 s | 3.4 s | 3.3 s | 3.2 s |
| Median, vite-react | 19.6 s | **16.1 s** | 5.7 s | 5.9 s |
| Median, nextjs | 16.2 s | 14.4 s | 13.9 s | 13.0 s |
| Median, all | 14.4 s | 13.2 s | 6.8 s | 6.5 s |
| Checks, summed over runs | 380 s | **184 s** | 369 s | **174 s** |

- **Checks take half the time.** The 27 apps with a caught fault spent 313 s in checks in v5
  (every failing assertion waited out its 20 s timeout) and 117 s in v6. A failing assertion
  now waits 5 s and then stops once the app's servers are idle. Passing apps are unaffected, and
  the answers are the same.
- **Vite seeds help apps that share a key.** 34 React apps have 20 keys. A seed is made when the
  second app of a key comes, so 12 seed runs took 165 s, and the apps after them started with the
  pre-bundled dependencies. vite-react's summed ready time fell from 380 s to 233 s, and its p90
  from 36.5 s (first v6 attempt, seeding every key) to 28.5 s.
- **The warm-up** (Vite, Vite + React and Next.js, side by side) took 57 s of the cold pass. The
  first apps of each stack then start from its installs and the Next.js seed.

A first attempt at v6 seeded every key and had a warm-up that could not render: its app wrote only
text into `#app`, which Sandburg's render check did not count as rendered. That check was a false
alarm waiting to happen for real apps too, and is fixed. The attempt spent 780 s, with 276 s in
the warm-up. React apps paid 329 s more in installs (seed runs for keys that only one app used)
for 266 s less in ready. Seeding on the second app of a key comes from that run.

## Where the time goes now

- **next dev** is the largest share: Next.js apps are a third of the corpus and 56% of the warm
  pass's run time (482 of 856 s summed over runs, 13.0 s median). Most of it is starting `next dev`
  and compiling each route on its first request.
- **Failing apps' checks** still take 115 s in the warm pass: 5 s per failing assertion at least,
  more when the app keeps its servers busy.
