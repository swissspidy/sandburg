# Testing

The suites, what they need and how long they take are in the README (Development) and in
[ADR 0043](adr/0043-test-suites.md); CI runs each e2e file as its own job and reports its times
(`scripts/test-times.ts`, budgets in `test/budgets.json`). This page is about keeping them reliable.

## Looking for flaky tests

A test that passes on an idle machine may fail when the machine is busy: CI's runners are noisy, and
suites are often run side by side with other work. Before trusting a new test, or after changing one
that waits for something, run it again and again under load:

```sh
node scripts/flakes.ts --runs 10 test/unit/*.test.ts                        # idle
node scripts/flakes.ts --runs 10 --cpu 4 --disk test/runtime/*.test.ts      # 4 CPU spinners and a disk writer
node scripts/flakes.ts --runs 5 --copies 2 --cpu 2 test/e2e/batch.test.ts   # two runs of the suite at once
```

`--cpu N` keeps N processes spinning on the CPU (use as many as the machine has cores), `--disk` writes
and syncs 64 MB files in a loop, `--copies N` runs the files N times at once (on one `.sandburg/`, as
two sessions or two suites on one machine do). It prints each run's failures, then each failing test
with how often it failed, and keeps every run's output. Chromium on fewer cores is another kind of
load: prefix the command with `taskset -c 0,1`.

What was found this way, and the patterns that fix it (ADR 0060):

- **A fixed wait for something asynchronous** (`setTimeout(…, 300)` "for the channel to open", 50 ms
  "for the record to land"): wait for the thing itself. Poll for the state with a deadline, or have
  the code under test say when it is done; in the runtime tests, a program's `channelOpen()`
  (`CHANNEL_OPEN` in `test/runtime/harness.ts`) resolves once its requests go over the file channel,
  and `holdChannel` keeps the channel closed until the program asks for it.
- **A run cut off by a timer**: the runtime harness ends a run when its program exits, or when the
  test's `until` holds for what it printed and asked for; its 30 s backstop only ends a run that hangs.
  A program that does not exit (a server, a thread: threads do not exit on their own in this runtime)
  says what it waits for with `until`.
- **Timers that the test races against** (the batch's apps sleeping 20 ms while another sleeps 200 ms
  and is expected to end last): make the slow one wait for the others, or use node:test's mocked
  timers (`mock.timers`) and advance them in the test.
- **Two processes started at once** (`node api.js & node web.js`): the second asks again while the
  first is not ready, as a real client would.

A longer timeout is a fix only with a measured reason (how long the thing takes on a loaded machine);
never skip a test, retry it, or loosen what it asserts.

## Keeping tests hermetic

- Unit tests make temporary directories with `tempDir()` (`test/unit/temp-dir.ts`): they are removed
  when the file's process exits, with whatever the host wrote into them after the tests ended.
- Servers listen on port 0 (the system picks a free port), on 127.0.0.1.
- e2e tests share `.sandburg/` (installs, caches) with each other and with your own runs: a test that
  needs a cold state removes what it needs removed itself (the Next.js seed test removes the seeds);
  one that needs another test's result says so (`node.test.ts`: the seed test runs first).
- A test's TCP server (`node:net`) gives each socket an `error` listener: a browser or proxy that
  closes may reset its connections, and an unhandled `ECONNRESET` ends the test file (#62). `node:http`
  servers handle their sockets' errors themselves.
