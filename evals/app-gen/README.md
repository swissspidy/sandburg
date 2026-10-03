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

Each task names the accessible names the checks use ("a text field labeled 'New task'"), so checks
can find controls by role and label without depending on how the model built them. Tasks that
store data check this by loading the app again with its browser storage cleared. What is still
there then came from the database.

## Running it

```sh
ANTHROPIC_API_KEY=… GEMINI_API_KEY=… node evals/app-gen/run.ts \
  --models claude-opus-5-5,gemini-3.1-pro-preview \
  --stacks vanilla,react,sveltekit \
  [--tasks todo,guestbook] [--fixes 2] [--parallel 3] [--install-in browser|host]
```

Results go to `.sandburg/evals/<timestamp>/`:

- `summary.md`, `summary.json`: one row per model and stack, and one per cell.
- `<model>__<stack>__<task>/`: `cell.json` (each attempt's tokens, time, files, run summary and the
  errors sent back), `transcript.md`, `files.json` (the final app, which `sandburg run` can run
  too) and `runs/` (Sandburg's `result.json`, screenshot and accessibility tree for each run).

`--rescore <dir>` runs the stored apps again with the suite's current checks and no model calls.
Use it after fixing a check, or to see whether a newer Sandburg runs the same apps. `--report <dir>`
writes the summary again from the stored results.

Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1` so that Node's `fetch` uses it.

## Reading the results

- **Excluded** cells have no score. Either Sandburg could not run the app (`runtime-unsupported`,
  or an `infra` failure that a retry did not fix), or the provider failed. A runtime gap is
  Sandburg's to fix, so it does not count against the model.
- **First try** counts cells whose first answer passed with no fix.
- **Failed: missing element / wrong output** says why the first failing check of each failed cell
  failed. "Missing element" means the app has no control or list with the name the task asked for
  (or has more than one): it did not follow the spec, though the app may work. "Wrong output" means
  the element is there but shows the wrong text or state. Checks run in order against one app, so a
  first failure often fails the checks after it too.
- **Generate** is the time spent waiting for the model, summed over all attempts. **Run** is
  Sandburg's total time for the last run: install, start, ready and checks.

## Writing a task

Add a task to `SUITE` in [`suite.ts`](suite.ts) with a `prompt` and `checks`. Checks are Sandburg
checks (`{ app, expect, appUrl }`) and run in order against one app. Before trusting a new check,
make sure a correct app passes it. A check that acts faster than a person would is a common cause
of false failures: wait for the result of one action before starting the next.
