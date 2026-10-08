# ADR 0023: Checks that run in the page

- Status: Accepted
- Date: 2026-10-08

## Context

A checks file is imported by Sandburg's Node process, where Playwright runs. Whoever writes it can
do anything a program on this machine can. That is fine for the checks of an eval, which its
authors wrote. It is not fine for checks a coding agent writes to try out its app: in a Harbor
trial ([`integrations/harbor`](../../integrations/harbor)) the agent may run `sandburg` and nothing
else, and `sandburg run --checks` let it run any code here.

Running the checks somewhere fenced leaves two choices. Their code can run in the browser and send
each Playwright call to the host, which carries it out with real input. Or their code and the
calls both run in the browser: locators resolved in the page, input from scripted events. The
second needs nothing from the host, which fits running all of Sandburg in a browser, but scripted
events are not trusted (`isTrusted` is false), and a locator engine and its waiting are a lot to
rebuild.

[ivya](https://github.com/vitest-dev/ivya) (MIT) is a fork of Playwright's locator resolution: it
resolves Playwright's selectors (`internal:role=button[name="Add"i] >> nth=0`), with the same
role, label and text matching, in the page. It also exports Playwright's visibility, checked and
disabled logic. [user-event](https://testing-library.com/docs/user-event/intro) (Testing Library)
dispatches pointer, keyboard and focus events in the order a browser would.

## Decision

- **`--checks-in page`** (`RunOptions.checksIn`) runs a checks file's code in the sandbox tab. The
  host reads the file and strips its TypeScript types (esbuild's transform: one file, no imports
  resolved, nothing run). The tab loads it as a module and runs its checks against the app's frame.
  The tab and the app share an origin (ADR 0004), so the checks can do no more than the app's own
  code. Results come back as data: names, statuses, messages, durations, validated and capped.
- **The same `app`, `expect` and `appUrl`, shaped as Playwright's** ([`src/page-checks/runtime.ts`](../../src/page-checks/runtime.ts)):
  - **Locators** are Playwright selector strings resolved by ivya, chained and filtered as
    Playwright chains them.
  - **Actions** wait for one element that is visible and enabled, and fail on several (strict
    mode). Clicks, typing and `selectOption` come from user-event. `fill()` inserts the text as
    Playwright does (`insertText`: one input event); date and similar inputs get their value set.
  - **Assertions** poll until they hold or time out, and fail with Playwright's message:
    locator, expected, received, timeout.
  - A wait that timed out or a failed assertion is `failed`; any other error is `error`, as for
    checks run on the host. A method that is not there says so by name.
- **What does not carry over**:
  - Events are scripted, so CSS `:hover` does not apply, and a native `<select>`'s list and the
    file chooser do not open.
  - The file cannot import anything.
  - Assertions wait their whole timeout; they do not stop early when the app is idle (ADR 0016).
  - Screenshots, `page.route` and other APIs that need the browser's own protocol are not there.
- **Harbor's `sandburg` is fenced** ([`integrations/harbor/fence.mjs`](../../integrations/harbor/fence.mjs)):
  - only `sandburg run`;
  - every path inside the trial's project;
  - packages installed in the browser, checks run in the page.

  The verifier runs Sandburg itself, with the task's checks on the host, as in the eval.

## Consequences

- The app-gen suite's checks agree with Playwright's on every check of the eval run of
  2026-10-06 ([`evals/app-gen/compare-checks-in.ts`](../../evals/app-gen/compare-checks-in.ts)).
  Each app and step ran on the host and in the page:
  - **Claude Opus 5.5's apps, all passing:** 60 steps, 168 checks, all passed in both modes.
  - **Gemini 3.1 Pro's apps:** 39 steps, 21 of them failing. Of their 110 checks, 58 passed,
    51 failed and 1 was broken (`error`), each the same in both modes.

  These are forms, buttons, lists and reloads; hover menus, drag and drop and custom selects are
  not in the suite.
- The page's runtime is about 300 KB (mostly ivya), bundled on first use.
- ivya follows Playwright's injected script; Sandburg's Playwright and ivya can drift apart in
  edge cases of matching.
