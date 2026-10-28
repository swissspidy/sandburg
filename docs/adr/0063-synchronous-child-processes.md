# ADR 0063: Synchronous child processes

- Status: Accepted
- Date: 2026-10-28

## Context

The runtime ran `child_process`'s asynchronous API (ADR 0012): `node` and the programs of the
runtime's shell (npm scripts, package binaries) in a child runtime, a nested Web Worker; other
programs exit with 127. `execSync`, `spawnSync` and `execFileSync` threw `ENOSYS` (spawnSync
returned it as `error`), because "the parent would have to block while serving the child's file
system" (ADR 0012). Real programs call them as they start: a config reads its git revision
(`execSync('git rev-parse --short HEAD')`, usually with a fallback), a CLI asks
`node -p process.versions` or runs a quick `node -e`, a build script runs `npm run build:icons`.
Their caller cannot go on until the command ends: an `ENOSYS` failed the program, or took the
fallback for a command that would have run.

What the parent's block breaks, measured in Chromium (a worker that creates a nested worker, posts to
it and waits in `Atomics.wait` for it to answer in shared memory, 3 s at most):

- **A worker the blocked thread starts never runs its first message.** Chromium holds a parent's
  messages to a new worker until the parent runs a task after the worker's script has run (ADR 0038):
  the fresh worker timed out (3,000 ms, twice). One created a task earlier answered at once.
- **A worker started by another, idle thread does not depend on the blocked one.** The parent posted
  to a helper worker it had started earlier, which created the child and posted to it: 14-19 ms.
- **The child's messages to its parent wait for the parent too**: its file system calls (ADR 0012's
  RPC posts each call), its output and its exit. While the parent blocks, nothing would read them.

## Decision

- **The child talks to its blocked parent through shared memory** (`node-runtime/sync-child.ts`): one
  growable `SharedArrayBuffer` per child (64 KiB, up to 1 GiB of reserved address space, or 256, 64
  or 16 MiB where that much cannot be reserved), a header and the data. The child writes a request (a file system call, stdout or stderr text, its exit) and
  waits; the parent, in `Atomics.wait` on the same header, serves it and answers. File system calls
  run on the parent's VFS as a thread's do (`vfsAnswer`, the same answer as `serveVfsCall`), so
  files written on either side are seen by both. A child runtime that is a synchronous child
  (`ThreadInit.process.sync`) routes what it would post to its parent there; what has no one to go
  to (servers it announces, IPC) is dropped. Output goes in pieces the channel takes; a file system
  call whose payload is larger than the channel (a file over 1 GiB) fails with `EFBIG` on whichever
  side meets it, not with a RangeError. A child marked dead also sets the header's state to a value
  of its own, so a parent that has just looked and is about to wait cannot miss it.
- **The runtime's helper worker starts the child** (host-files.ts' helper, ADR 0025/0029;
  `SPAWN_HELPER` in sync-child.ts): a `spawn` message gives it the init message and its ports; the
  helper creates the worker, posts the init, and terminates it on `end`. A worker that fails, or a
  spawn the helper refuses, marks the channel dead, and the parent stops waiting. The helper starts
  only the runtime's script, whose URL (`${base}/node-worker.js`) the main runtime names once; a
  spawn names no URL.
  - **A tree of runtimes.** Each runtime that may start synchronous children has a node in the
    helper, named by the tag of its spawner port, under the runtime that registered the port. Only a
    node's parent may start or end it. Ending a node terminates its worker and every node under it:
    a synchronous grandchild's worker is the helper's, not its parent's, and outlived it (a ticker
    started by `execSync` in a child killed by its timeout, or in an asynchronous child killed while it
    waited, kept ticking). A runtime that ends its asynchronous child or thread (`ThreadHost.ended`)
    ends its node too, so the helper forgets runtimes that are gone.
  - Every main runtime has a helper now: one without an install key (a project without dependencies)
    or with packages installed in the browser kept or started one only for this
    (`startDigester(false)`: no digests, no file channel).
  - Threads and child processes get a port to the main runtime's helper (`shareSpawner`, in the init
    message), as they get one to its file channel: a synchronous command in a child process, or in a
    synchronous child, starts its child the same way. A child process with an install starts a file
    helper of its own as well; it keeps using the main runtime's for synchronous children (its own is
    not up while its program starts).
  - A helper is reachable once it has had this thread's first message (`helper.up`, its existing
    hello). A main runtime whose helper is still starting waits for it before it runs its program, up
    to 500 ms (`HELPER_PATIENCE_MS`): a program may call `execSync` before it runs a task. A prepared
    runtime (the host page's, ADR 0031) started its helper long before and does not wait. An
    unprepared one waits whether or not its program runs a synchronous command: the wait cannot be
    left to the first `execSync`, because what it waits for is this thread running a task (Chromium
    hands the helper this thread's messages then), and a synchronous call cannot run one. Measured
    over 50 starts of the runtime tests' programs (`core.test.ts`, unprepared runtimes, 4 cores): a
    median wait of 6.6 ms (90th percentile 11 ms, at most 47 ms) on an idle machine, 11 ms (15 ms,
    at most 20 ms) with every core busy with another process. The 500 ms bound only applies to a
    helper that does not start.
- **The shell runs synchronously** for these calls (`ShellHost.sync`): a builtin ends at once rather
  than in a microtask, `sleep` waits in `Atomics.wait`, and each Node program it starts is a
  synchronous child. So `execSync('echo a && node -p 1 && exit 4')` runs as it does asynchronously,
  and a command that is not a Node program exits with 127, synchronously, with the shell's message on
  stderr (`git` starts no runtime): status 127 from the shell, also for `spawnSync('git', …)` without
  a shell, where Node reports `ENOENT` (or runs git). `sleep` reads its arguments as GNU sleep does
  (`0.5`, `2s`, `1m`, several summed; an invalid one exits 1 with GNU's message), in both modes;
  `sleep inf` without a timeout fails the call (`EINVAL`) rather than block the thread for good.
- **Node's semantics** (Node 24's own output for each test program): `status`, `signal`, `stdout`,
  `stderr`, `output`, `pid`, `error`; `encoding`; `input` as the child's stdin; `stdio` `pipe`,
  `ignore`, `inherit` (written to this process's output as it comes); `timeout` and `maxBuffer` (the
  child is killed: `ETIMEDOUT` or `ENOBUFS`, `status` null, `signal` the `killSignal`, SIGTERM by
  default); execSync and execFileSync throw Node's `Command failed: …` error with the result's
  properties on a non-zero exit and show the child's stderr unless `stdio` is given. A numeric
  `killSignal` is reported by name (9: `SIGKILL`). `node` without a script runs its `input` (an empty
  script without one), as Node runs what stdin gives it. A command that cannot start (no helper, or
  one that never came up) fails at once with `ENOSYS` and a message that names the call
  (`child_process.execSync("…") cannot run yet: …`), instead of blocking; the result has Node's keys,
  with what the command wrote before it (`output`, `stdout`, `stderr`).

## Consequences

- execSync, spawnSync and execFileSync run Node programs and the shell's commands. A Node program
  costs a runtime's start and its end: `execSync('node -e "console.log(6 * 7)"')` took ~340 ms in the
  runtime tests (a child that ends on its own is taken to be done after 200 ms idle, as an
  asynchronous child is; `process.exit` ends it at once). Shell builtins and commands that are not
  Node programs start no runtime.
- While it blocks, the caller does nothing else, as in Node: its servers, timers and its other
  children's messages wait. Its threads see a blocked parent, as they do when WebAssembly blocks it
  (ADR 0012's fallbacks).
- A synchronous child's servers are not reachable from the page or the parent (they end with it),
  and a server never ends on its own: `execSync('npm run dev', { stdio: 'inherit' })` blocks its
  caller for good (until its `timeout`), with a server nothing can reach. Start servers with `spawn`.
- `git` and other programs that are not Node programs give status 127 through the shell, not
  `ENOENT`: a fallback that catches the error works, one that tests `e.code === 'ENOENT'` does not.
- Benchmark (`scripts/bench.ts`, origin/main against the branch, warm, interleaved, 4 rounds, medians
  of the total): `node-express` 0.75 → 0.81 s (+7%), `vite-react-counter` 1.80 → 1.85 s (+2%),
  `lit-vite` 1.45 → 1.50 s (+4%), with phases the change does not touch (mount, checks) moving as
  much; `node-express` again at 8 rounds: 0.73 → 0.74 s (+0%). A prepared runtime does not wait for
  its helper; what the change adds to a run is a port per nested runtime and a branch per message to
  the parent.
- The process tree's "starting" count (ADR 0055) does not count synchronous children: their parent
  cannot be serving the page while they start.

## Security

- The helper starts only the runtime's own script, on the page's origin, so a message to it cannot
  start other code; the program could start such a worker itself anyway. Its ports are the
  runtime's, never the program's.
- The channel is a `SharedArrayBuffer` between the parent runtime, the helper and the child, in the
  run's tab, as the threads' file system RPC is (ADR 0012): the child's file system is the parent's,
  as an asynchronous child's is. Nothing leaves the run.

## Not done

- **Spare runtimes for synchronous children** (ADR 0027): the helper starts a new runtime each time
  (the runtime script comes from Cache Storage with V8's code, ADR 0049). A spare would save its
  start, at the cost of keeping one for every program that might call execSync.
- **An earlier exit for a child that is done**: an idle child is still detected after 200 ms, as for
  asynchronous children.
- `fs.readFileSync(0)` (stdin by file descriptor): `input` reaches `process.stdin` only.
