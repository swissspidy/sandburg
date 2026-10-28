# ADR 0068: Uncaught exceptions, unhandled rejections and signals as in Node; signals stop a command cleanly

- Status: Accepted
- Date: 2026-10-28

## Context

A program whose main module throws at the top level, with a `process.on('uncaughtException', …)`
listener that logs and calls `process.exit(3)`, ends in Node with that output, its `'exit'`
listeners and code 3. The runtime ended it with its error (`fatal`) before any listener ran. PR #108
had made `process.exit` in such a listener work only for throws after start-up, from a timer or I/O.
Checking the rest of the family against Node 24 found more differences:

- A throw a listener took did not let the program go on (Node: its timers still fire).
- Without a listener, `'exit'` listeners did not run. Node runs them with code 1 (`process.exitCode`
  is 1), and one that calls `process.exit()` or sets `process.exitCode` sets the exit code.
- A throw from a timer with no listener left the worker's `error` event unhandled. The page reported
  it as an internal error ("runtime worker error"), not as the app's crash.
- `'uncaughtExceptionMonitor'` was never emitted. `process.setUncaughtExceptionCaptureCallback` did
  nothing. `hasUncaughtExceptionCaptureCallback` always returned false.
- A throw inside a listener did not exit with Node's code 7.
- An unhandled rejection only printed `Uncaught (in promise) …`, and the program went on. Node 24's
  default (`--unhandled-rejections=throw`) makes it an uncaught exception: the process ends with it
  unless an `'unhandledRejection'` or `'uncaughtException'` listener takes it. Node's other modes and
  `'rejectionHandled'` were missing.
- An ES module's throw, and its top-level await's rejection, are uncaught in Node with the origin
  `unhandledRejection`, because module evaluation is a promise there. The entry's rejection skips
  the `'unhandledRejection'` listeners.
- `process.emitWarning` wrote straight to stderr. It emitted no `'warning'` event.
- When the event loop drained, `process.exitCode` was set to 0 before `'exit'`. Node leaves it
  undefined.

Signals:

- On Windows, Ctrl-Break sends SIGBREAK. Sandburg's commands listen for SIGINT only. `compare`
  listens for SIGINT and SIGTERM itself. `run`, `batch` and `open` rely on Playwright's listener,
  which closes the browsers and then exits 130. Meanwhile the closed browser fails the run, and that
  error, uncaught, ended a real Ctrl-C with exit code 1 first. Nothing listened for SIGBREAK, so
  Ctrl-Break ended the process at once and left the browser and the reference's containers behind.
- In the runtime, `process.kill()` returned true and did nothing, whatever its arguments.
  `child.kill('SIGBREAK')` "killed" the child with that signal. `os.constants.signals` had 4 of
  Linux's 31 signals. Node on Linux, the platform the runtime reports, does not know SIGBREAK:
  `process.kill(pid, 'SIGBREAK')` and `child.kill('SIGBREAK')` throw `ERR_UNKNOWN_SIGNAL`, while
  `process.on('SIGBREAK')` is an ordinary listener that never fires.

## Decision

**One place handles uncaught errors** (`src/node-runtime/uncaught.ts`), as Node's
`lib/internal/process/execution.js` and `promises.js` do. The worker's `error` and
`unhandledrejection` events, a CommonJS entry's throw, and an ES module entry's throw or rejection
all go through it:

1. `'uncaughtExceptionMonitor'` is emitted (with the origin).
2. The capture callback takes the error, if set. Otherwise the `'uncaughtException'` listeners do.
   Either way the process goes on.
3. With neither, the process gets `process._exiting` and exit code 1, and `'exit'` is emitted
   once. Then the runtime ends with the error. Its parent reports exit code 1, the page an APP
   failure with the stack. The exception: when an `'exit'` listener left another exit code, the
   stack goes to stderr and the process exits with that code.
4. A throw in a listener, the monitor or the capture callback prints that error and exits 7,
   without `'exit'`.

A worker thread (not a process) keeps ending with its `'error'`, as before.

The entry's origin follows its module system. A CommonJS entry's throw is `uncaughtException`, taken
at once (before ticks and microtasks, as in Node). An ES module entry's throw, and its top-level
await's rejection, are `unhandledRejection` and come a microtask later. `process.exit()` at an ES
module's top level is not deferred: the process ends at once, and what it queued does not run.

**`--unhandled-rejections`** is read from the process's options or `NODE_OPTIONS`. `throw` is the
default, and `strict`, `warn`, `none` and `warn-with-error-code` behave as in Node, including the two
`UnhandledPromiseRejectionWarning`s. A reason that is not an error is wrapped in Node's
`UnhandledPromiseRejection` (`ERR_UNHANDLED_REJECTION`). The browser's `rejectionhandled` event
becomes `'rejectionHandled'`, or a `PromiseRejectionHandledWarning` when nothing listens.
A DOMException reason (an AbortError) is passed on as it is, as in Node, although the browser's
DOMException inherits its `stack`. Any other object whose stack is inherited is wrapped, as in Node.

`process.emitWarning` emits `'warning'` on the next tick, and rejects a warning that is neither a
string nor an Error (`ERR_INVALID_ARG_TYPE`). A listener the process installs prints it in Node's
format, so a program that removes the `'warning'` listeners prints nothing. As in Node:
- `--no-warnings` or `NODE_NO_WARNINGS=1` leave that listener out;
- `--no-deprecation` (`process.noDeprecation`) drops DeprecationWarnings;
- `--throw-deprecation` (`process.throwDeprecation`) throws them on the next tick;
- `--trace-deprecation` and `--trace-warnings` print the stack, and no hint.

**Signals in the runtime follow Linux.** `os.constants.signals` is Linux's full table.
`process.kill` validates as Node's does:

- a pid that is not an integer: `ERR_INVALID_ARG_TYPE`;
- an unknown signal name, SIGBREAK included: `ERR_UNKNOWN_SIGNAL`;
- an unknown signal number: `EINVAL`.

A signal a process sends itself reaches its listeners as `(name, number)`, after the ticks queued with
it and before immediates. With no listener, a signal that would end a process ends it at once, in
`process.kill()` (nothing after it runs), without `'exit'`, with exit code 128 + its number. That is what a shell reports for it: the runtime has no
exit by signal, so its parent sees `code 143` where Node's sees `signal 'SIGTERM'`. Signals Node ignores (SIGPIPE), that are
ignored or stop a process (SIGCHLD, SIGWINCH, SIGSTOP, …), and SIGUSR1 (Node starts its inspector;
the runtime has none) change nothing. A pid that is not the process's own
is not looked up (true, as before). `child.kill()` validates its signal the same way: what is not a
signal's name or number is `ERR_UNKNOWN_SIGNAL`, whatever its type. Signal 0, as in Node, only
probes the child: true (and `killed`) while it runs, false once it has
ended, and the child goes on, to its own exit and close (a shell-run one too).

**Ctrl-C, a kill, a closed terminal and Ctrl-Break stop a command** (`src/stop-signals.ts`).
`untilStopped` holds the listeners a command's signals already have, as they are (`rawListeners`: a
`once` listener stays one), stops the command's work on the first signal, then exits with 128 + the
signal's number: SIGINT 130, SIGTERM 143, SIGHUP 129, SIGBREAK 149 (SIGBREAK is 21 on Windows).

- The CLI's session leaves Playwright's own SIGINT, SIGTERM and SIGHUP listeners out
  (`SessionOptions.handleSignals: false`). They would close the browser and, on SIGINT, exit 130
  while Sandburg's cleanup (the reference's containers) still runs. A library caller's session keeps
  them.
- `compare` uses it for all four, as it already did for SIGINT and SIGTERM: it removes the
  reference's containers, closes the session, and writes no report.
- `run`, `batch` and `open` use it for all four too: it closes the session (and its browser). What
  the closed browser fails in the runs meanwhile is not the outcome, so a real Ctrl-C exits 130 (not
  1, as when Playwright's listener closed the browser under the run) and a kill exits 143. The session closes once, also when a signal comes while it closes after its run.
- The listeners go in before the session opens. A signal that comes while the browser launches
  waits for the launch to finish, then closes the session. The command starts no run after it.
- A second signal goes to the listeners the command's signals had before it started, or to the
  signal's default action, which ends the process at once.

Listening for SIGBREAK is harmless off Windows: nothing sends it there. The tests raise it with
`process.emit` (on every platform) through the child's stdin, as the compare signal tests already do
on Windows.

## Consequences

- A program Node ends with an unhandled rejection now ends in the runtime too. One that ran on with
  only a stderr line before now fails its run. Node does the same, so it is a fidelity fix. A runtime
  module's own stray rejection would show up the same way, as an APP failure. None did in the
  runtime and e2e suites, or in the fidelity corpus. Apps 100–231 (132 apps, all 14 stacks) ran
  cold on this change and on main: 132/132 right here, 131/132 on main. The difference is an
  intermittent WebAssembly trap in Angular's dependency optimizer on main (178), as v7 saw for
  134. No run on either side logged an unhandled rejection.
- A throw from a timer or I/O that nothing catches is reported as the app's error (APP, with its
  stack), not as "runtime worker error" (INTERNAL).
- Known limits:
  - The runtime's `process.nextTick` callbacks are microtasks. For an ES module entry's throw, ticks
    and microtasks therefore run before the listener in queue order, where Node runs microtasks, the
    listener, then ticks.
  - The browser reports an unhandled rejection after the task that follows its own. A promise
    handled in the next `setImmediate` callback counts as handled here, but not in Node.
  - An invalid `--unhandled-rejections` value is ignored (Node refuses to start, exit code 9).
- `untilStopped` gives later commands one way to stop on a signal.
