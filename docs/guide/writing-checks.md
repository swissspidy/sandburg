# Writing checks

A checks file tells Sandburg what the app must do. Every run also has [built-in checks](#built-in-checks),
so a run without a checks file still fails on a server error or an uncaught error in the app.

```sh
npx sandburg run ./my-app --checks checks.spec.ts
```

## The Checks API

A checks file default-exports named checks. Each check is a function that gets a context
(`CheckContext`, exported by the package):

| Field | What it is |
|---|---|
| `app` | The app's frame, a Playwright [`Frame`](https://playwright.dev/docs/api/class-frame): `getByRole`, `getByLabel`, `locator`, `goto`, … |
| `page` | The sandbox tab's Playwright `Page` (the app's frame is inside it). |
| `expect` | Playwright's `expect`, with its web-first assertions (`toHaveText`, `toBeVisible`, `toPass`, …). |
| `appUrl(path)` | The app's URL for `path` on its own sandbox origin: `app.goto(appUrl('/about'))`. |
| `signal` | An `AbortSignal` that aborts when the check is stopped (see [Time limits](#time-limits)). |

```ts
import type { Checks } from 'sandburg';

export default {
  'counter increments on click': async ({ app, expect }) => {
    await app.getByRole('button', { name: /count is/ }).click();
    await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 1');
  },
  'about page': async ({ app, expect, appUrl }) => {
    await app.goto(appUrl('/about'));
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('About');
  },
} satisfies Checks;
```

Every check in the file is blocking: one that fails fails the run (exit code `1`). A check that fails
an assertion or a wait is `failed`; any other error it throws is `error`. Both block.

A failing assertion stops waiting once the app is idle, after at least 5 s, rather than waiting its whole
timeout ([ADR 0016](../adr/0016-faster-batches.md)); `failFastChecks: false` in the library's
`RunOptions` turns that off. An assertion's own timeout (`timeouts.expect`) is 20 s in the node runtime,
because routes compile on their first request (`next dev`), which is slower in the browser; it is
Playwright's 5 s in the Docker reference.

## Time limits

Each check has a time limit (`timeouts.check` in the library's [`RunOptions`](library.md#timeouts)),
and all of them together have the checks phase's (180 s; `timeouts.checks`). The per-check limit is 60 s
in the node runtime, which raises `DEFAULT_TIMEOUTS`' 30 s along with its install, start and ready
limits (a cold npm install of a Next.js app and its first webpack compile take a while;
[`src/adapters/node/index.ts`](../../src/adapters/node/index.ts)), and 30 s in the Docker reference.

A check that runs out of time is stopped, not left running beside the next one:

- the Playwright call it is waiting in fails;
- any call it makes after that fails (after a moment, so a loop that ignores the error does not stall
  the run);
- its `expect(…).toPass()` stops retrying;
- the route handlers and event listeners it added to `page` are removed (not those it added to
  `page.context()`, nor `routeWebSocket()` handlers).

The app is then loaded again at the URL it first loaded at; its result (failed) says so.

A check also gets `signal`, an `AbortSignal` that aborts when it is stopped: pass it to waits of its
own (a timer, a `fetch` of another service), which Sandburg cannot stop. A check run on the host is
Node.js code, so a timer is `node:timers/promises`' (a checks file that runs in the page cannot import
it):

```ts
import { setTimeout } from 'node:timers/promises';
import type { Checks } from 'sandburg';

export default {
  'the notice goes away on its own': async ({ app, expect, signal }) => {
    await app.getByRole('button', { name: 'Save' }).click();
    await expect(app.getByRole('status')).toHaveText('Saved');
    // Stopped with the check: the timer rejects when signal aborts.
    await setTimeout(3_000, undefined, { signal });
    await expect(app.getByRole('status')).toBeHidden();
  },
} satisfies Checks;
```

To reach the app's own routes, go through the app: `app.goto(appUrl('/api/health'))`, or a `fetch` in
the app's frame (`app.evaluate`). Sandburg's host does not answer them to a request from Node.

When the checks phase runs out of time, the checks that finished and the artifacts already taken are
kept: the check that was running fails, and those that had not started are reported as skipped
(`not run`); the run's status is `error`.

## What is reset between checks

The checks run one after another, against the same running app. When a check is stopped, the app is
loaded again at its first URL. Loading it again resets only what lives in the page: cookies,
`localStorage`, IndexedDB, service workers, the context's routes, the viewport and a fake clock carry
over to the next check. The app's server and its data (a SQLite database, say) are the same for every
check.

Write each check so that it does not depend on another's leftovers, or so that the order in the file
is the order it needs.

## Checks in the page (`--checks-in page`)

A checks file is imported by Sandburg's Node process: it can do anything a program on this machine
can. For checks someone else wrote (a coding agent), `--checks-in page` runs the file's code in the
sandbox tab instead, with the same `app`, `expect` and `appUrl`: Playwright's locators (resolved by
[ivya](https://github.com/vitest-dev/ivya)), actions and assertions, waiting as Playwright's do
([ADR 0023](../adr/0023-checks-in-the-page.md)).

```sh
npx sandburg run ./my-app --checks checks.spec.ts --checks-in page
```

The host only reads the file and strips its TypeScript types. The tab and the app share an origin, so
the checks can do no more than the app's own code. Results come back as data. How this fits an agent's
workflow is in [Agents and CI](agents-and-ci.md#the---checks-in-page-trust-model).

What does not carry over:

- The file cannot import anything (`import type` is fine: types are stripped).
- Input comes from scripted events, so CSS `:hover` does not apply, and a native `<select>`'s list and
  the file chooser do not open.
- Assertions wait their whole timeout; they do not stop early when the app is idle.
- Screenshots, `page.route` and other APIs that need the browser's own protocol are not there.
- Waits and actions stop when a check runs out of time, as on the host, but code of a check that
  catches the error and goes on cannot be stopped.
- A method that is not there says so by name.

## Built-in checks

Every run has these, without a checks file ([`src/orchestrator/checks.ts`](../../src/orchestrator/checks.ts)):

| Check | Blocking | What it does |
|---|---|---|
| The page is not a server error (`document`) | yes | The app's page did not answer with a server error. |
| No uncaught errors in the app (`console`) | yes | No uncaught error in the app's own code. |
| No failed or blocked requests (`network`) | no | Failed or blocked requests are reported, without failing the run. |
| Screenshot (`screenshot`) | no | `screenshot.png` in the run's directory. |
| Accessibility tree snapshot (`a11y-snapshot`) | no | `a11y.yaml` in the run's directory. |
| axe-core accessibility scan (`axe`) | no | Its violations are recorded, not enforced. |

## Waiting for the app

The checks start once the app has rendered. If it renders a loading state first, `--ready <selector>`
(`readySelector` in `RunOptions`) waits for a selector before the checks start:

```sh
npx sandburg run ./my-app --checks checks.spec.ts --ready '#root main'
```

Inside a check, prefer Playwright's web-first assertions (`await expect(locator).toHaveText(…)`), which
wait, to fixed sleeps.

## Examples

A form and a list:

```ts
import type { Checks } from 'sandburg';

export default {
  'todo can be added and completed': async ({ app, expect }) => {
    await app.getByLabel('New todo').fill('Write the ADR');
    await app.getByRole('button', { name: 'Add' }).click();
    const item = app.getByRole('list', { name: 'Todos' }).getByRole('listitem');
    await expect(item).toHaveText('Write the ADR');
    await item.getByRole('checkbox').check();
    await expect(item.getByRole('checkbox')).toBeChecked();
  },
} satisfies Checks;
```

Data that survives a reload (a backend with SQLite):

```ts
'a saved note is still there after a reload': async ({ app, expect, appUrl }) => {
  await app.getByLabel('Note').fill('hello');
  await app.getByRole('button', { name: 'Save' }).click();
  await app.goto(appUrl('/'));
  await expect(app.getByRole('listitem').filter({ hasText: 'hello' })).toBeVisible();
},
```

The fixtures each have a checks file of their own:
[`fixtures/vite-react-counter/checks.spec.ts`](../../fixtures/vite-react-counter/checks.spec.ts)
is the one the quick start runs.

In `batch` and `compare`, a project's own `checks.spec.ts` (or `app.checks.spec.ts` next to `app.zip`)
takes precedence over `--checks` ([CLI](cli.md#batch)).
