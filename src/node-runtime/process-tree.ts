/**
 * How many of the program's processes are still starting, for the page's search for the app's port
 * (NodeProcess.pagePort). A process is starting while it runs and serves no HTTP port of its own:
 * a build step (`tsc && node server.js`), or a dev server that listens
 * only once it has compiled (ng serve). The program Sandburg starts to run the dev script does
 * nothing but wait on the script's commands, so it does not count while they run; any other
 * program does until it serves a port, children or not (concurrently, next dev's parent, a dev.js
 * that forks an API and then starts its page's server). A runtime whose shell script has commands
 * still to start (`node api.js & sleep 2 && vite`) is starting too.
 *
 * Each runtime reports its count to its parent ('starting' messages): its own (1 or 0; a worker
 * thread is no process and counts 0) plus what each nested runtime it started reported last. A child
 * process counts as starting until it reports; a nested runtime that ends counts no more. The
 * program's runtime reports the whole tree's count to the page. Zero means every process that is
 * left serves a port: no other server is still coming.
 */
import type { ToParent } from './messages.ts';

let isProcess = false;
let serving: () => boolean = () => false;
let post: ((m: Extract<ToParent, { type: 'starting' }>) => void) | null = null;
/** Each nested runtime this one started and runs: whether it is a child process, and the count it reported last. */
const nested = new Map<object, { process: boolean; count: number }>();
let reported = -1;
/** Steps of this runtime's shell scripts that have more steps after them, running now (ShellHost.stepsAhead). */
let stepsAhead = 0;

/** At init: whether this runtime is a process (the program's, or a child process), how to tell it serves a port, and where to report. */
export function initProcessTree(options: { process: boolean; serving: () => boolean; post: (m: Extract<ToParent, { type: 'starting' }>) => void }): void {
  isProcess = options.process;
  serving = options.serving;
  post = options.post;
  update();
}

/** A nested runtime started: a child process counts as starting until it reports, a worker thread as nothing. */
export function nestedStarted(runtime: object, process: boolean): void {
  nested.set(runtime, { process, count: process ? 1 : 0 });
  update();
}

/** A nested runtime's report (ignored once it ended). */
export function nestedReported(runtime: object, count: number): void {
  const entry = nested.get(runtime);
  if (!entry) return;
  entry.count = Math.max(0, Math.floor(count) || 0);
  update();
}

export function nestedEnded(runtime: object): void {
  if (nested.delete(runtime)) update();
}

/** Dev scripts this runtime's program (Sandburg's, which does nothing else) runs now (devScriptRunning). */
let devScripts = 0;

/** The dev script Sandburg's program runs started (+1) or ended (-1): while it runs, the program only waits on the script's commands. */
export function devScriptRunning(delta: 1 | -1): void {
  devScripts = Math.max(0, devScripts + delta);
  update();
}

/** A shell script's step with more steps after it started (+1) or ended (-1): the script has commands still to start. */
export function shellStepsAhead(delta: 1 | -1): void {
  stepsAhead = Math.max(0, stepsAhead + delta);
  update();
}

/** This runtime's servers changed (one listened or closed). */
export function serversChanged(): void {
  update();
}

/** This runtime's count: its own, plus its nested runtimes'. */
function starting(): number {
  let count = 0;
  let children = false;
  for (const entry of nested.values()) {
    count += entry.count;
    // A child process (or a thread's) is one to wait on; a worker thread is part of this process.
    if (entry.process || entry.count > 0) children = true;
  }
  // This runtime counts once: while a script it runs has commands still to start, or while it is a
  // process that serves no port, unless it is Sandburg's program for the dev script with the
  // script's commands running. Any other program with children (concurrently, a dev.js that forks
  // an API and then starts its page's server) may still start a server of its own.
  return count + (stepsAhead > 0 || (isProcess && !(children && devScripts > 0) && !serving()) ? 1 : 0);
}

function update(): void {
  if (!post) return;
  const count = starting();
  if (count === reported) return;
  reported = count;
  post({ type: 'starting', count });
}
