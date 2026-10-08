# App-generation eval

How well does a model build a working app on a given stack, when the app runs in Sandburg? This
eval runs every combination of model, stack and task. Each combination (a cell) goes through what
the [generator page](../../pages/generate) does:

1. The model gets the page's system prompt, the stack's scaffold and the task
   ([`prompt.ts`](../../pages/generate/prompt.ts), [`templates.ts`](../../pages/generate/templates.ts)),
   and answers in the page's file format ([`files.ts`](../../pages/generate/files.ts)).
2. Sandburg runs the app in a browser tab. By default the page installs the packages from the npm
   registry itself (`--install-in browser`), as it does on the demo site.
3. If the run reports errors, they go back to the model, at most `--fixes` times (default 2). These
   are the errors the page would collect: a failed install or start, error lines on the dev
   server's stderr, and uncaught errors or `console.error` calls in the app. Failing checks are
   never shown to the model.
4. The task's checks ([`suite.ts`](suite.ts)) decide the score: the share of checks that pass, and
   whether the cell passed (all of its checks, and Sandburg's own blocking checks).

5. If the task has a follow-up request and the app passed, the model gets the follow-up in the
   same conversation, as the visitor's next request on the page. The changed app runs again with the
   SQLite files its last run left behind, as the page keeps them across a restart. The follow-up
   gets its own fixes and checks. Its checks run in a fresh browser, so earlier data they find came
   through the change, which usually means migrating a table that already has rows. The eval also
   records whether the page would have written the change into the running app (its dev server
   reloads it) or started the app again.

Each task names the accessible names the checks use ("a text field labeled 'New task'"), so checks
can find controls by role and label without depending on how the model built them. Tasks that
store data check this by loading the app again with its browser storage cleared. What is still
there then came from the database.

## Running it

```sh
ANTHROPIC_API_KEY=… GEMINI_API_KEY=… node evals/app-gen/run.ts \
  --models claude-opus-5-5,gemini-3.1-pro-preview \
  [--stacks vanilla,react,sveltekit,nextjs,nuxt,angular] \
  [--tasks todo,guestbook] [--fixes 2] [--parallel 3] [--install-in browser|host]
```

Results go to `.sandburg/evals/<timestamp>/`:

- `summary.md`, `summary.json`: one row per model and stack, and one per cell.
- `<model>__<stack>__<task>/`: `cell.json` (each attempt's tokens, time, files, run summary and the
  errors sent back; the follow-up under `edit`), `transcript.md`, `files.json` (the app after the
  first request, which `sandburg run` can run too), `data.json` (its database after its checks),
  `files-edit.json` (the app after the follow-up) and `runs/` (Sandburg's `result.json`, screenshot
  and accessibility tree for each run).

`--rescore <dir>` runs the stored apps again with the suite's current checks and no model calls (the
follow-up's app with the database of the first app's new run).
Use it after fixing a check, or to see whether a newer Sandburg runs the same apps. `--report <dir>`
writes the summary again from the stored results.

Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1` so that Node's `fetch` uses it.

## Reading the results

- **Excluded** cells have no score. Either Sandburg could not run the app (`runtime-unsupported`,
  or an `infra` failure that a retry did not fix), or the provider failed. A runtime gap is
  Sandburg's to fix, so it does not count against the model.
- **First try (original checks)** counts cells whose first answer passed with no fix, with the
  checks of the original run. `--rescore` updates the final scores with the current checks, not this.
- **Failed: missing element / wrong output** says why the first failing check of each failed cell
  failed. "Missing element" means the app has no control or list with the name the task asked for
  (or has more than one): it did not follow the spec, though the app may work. "Wrong output" means
  the element is there but shows the wrong text or state. Checks run in order against one app, so a
  first failure often fails the checks after it too.
- **Follow-up passed** counts the follow-ups that passed, out of those that ran (the first request
  passed and the runtime could run the app). **Follow-up live** counts those the page would have
  applied to the running app without starting it again.
- **Generate** is the time spent waiting for the model, summed over all attempts. **Run** is
  Sandburg's total time for the last run: install, start, ready and checks.

## Writing a task

Add a task to `SUITE` in [`suite.ts`](suite.ts) with a `prompt` and `checks`, and optionally a
`followUp` with its own `prompt` and `checks`. The follow-up's checks start from the data the first
checks left. Checks are Sandburg
checks (`{ app, expect, appUrl }`) and run in order against one app. Before trusting a new check,
make sure a correct app passes it. A check that acts faster than a person would is a common cause
of false failures: wait for the result of one action before starting the next.

## Checks in the page

`compare-checks-in.ts` runs the suite's checks on an eval run's apps twice: on the host, with
Playwright, and in the page (`--checks-in page`, [ADR 0023](../../docs/adr/0023-checks-in-the-page.md)).
It then lists every check whose status differs between the two:

```sh
node evals/app-gen/compare-checks-in.ts .sandburg/evals/<run> [--model claude-opus-5-5] [--parallel 3]
```
