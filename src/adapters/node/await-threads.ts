/**
 * The rewrite of awaits (node-runtime/await-context.ts: the scan and the parse check of its output)
 * for installed files, on threads of their own.
 *
 * On the host's main thread they took 0.25 s of a cold vite-react-counter start and 1.8-2.1 s of a
 * cold next-app-router one (the scan ~70%, the check the rest), while the runtime waited on the same
 * thread for its next file. Here the main thread only posts each file's code to a helper, which runs
 * the same contextAwaits (compiled with `Function`, never called, as on the main thread) and answers
 * its output, or null to lower. A helper that fails is not used again: its files, and later ones,
 * are rewritten on this thread, with the same result.
 */
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { contextAwaits } from '../../node-runtime/await-context.ts';

const TAG = 'sandburg-await-threads';

/** Helpers: the main thread, esbuild and the browser need the other cores. */
const SIZE = Math.max(1, Math.min(2, availableParallelism() - 2));

/** Code smaller than this is rewritten on this thread: posting a file costs ~0.03 ms, rewriting 1 KB ~0.1 ms. */
const INLINE_MAX = 1 << 10;

interface Helper {
  worker: Worker;
  /** Its files not answered yet, by id: their code is kept, to be rewritten here if the helper fails. */
  waiting: Map<number, { code: string; done: (out: string | null) => void }>;
}

let helpers: Helper[] = [];
let ids = 0;
/** A helper failed: later rewrites are made on this thread (a helper that cannot start is not started again for each). */
let onThisThread = false;

/** contextAwaits(code), on a helper's thread when it is worth it. */
export function contextAwaitsSoon(code: string): Promise<string | null> {
  if (onThisThread || code.length < INLINE_MAX || !code.includes('await')) return Promise.resolve(contextAwaits(code));
  return new Promise((done) => {
    try {
      if (helpers.length < SIZE) helpers.push(startHelper());
      // The helper with the fewest files waiting.
      const { worker, waiting } = helpers.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
      const id = ++ids;
      waiting.set(id, { code, done });
      // Held open while it has files (as the file writer is), not after.
      if (waiting.size === 1) worker.ref();
      worker.postMessage({ id, code });
    } catch {
      onThisThread = true;
      done(contextAwaits(code));
    }
  });
}

/**
 * Starts the helpers ahead of the first transform (a helper takes ~90 ms to load the scan, which
 * the first files of a cold start would wait for). They stay idle, and do not keep the process
 * alive, until then.
 */
export function warmAwaitThreads(): void {
  try {
    while (!onThisThread && helpers.length < SIZE) helpers.push(startHelper());
  } catch {
    onThisThread = true;
  }
}

function startHelper(): Helper {
  const worker = new Worker(new URL(import.meta.url), { workerData: { tag: TAG } });
  const helper: Helper = { worker, waiting: new Map() };
  const { waiting } = helper;
  worker.on('message', ({ id, out }: { id: number; out: string | null }) => {
    waiting.get(id)?.done(out);
    waiting.delete(id);
    if (!waiting.size) worker.unref();
  });
  const lost = () => {
    onThisThread = true;
    helpers = helpers.filter((h) => h !== helper);
    for (const { code, done } of waiting.values()) done(contextAwaits(code));
    waiting.clear();
  };
  worker.on('error', lost);
  worker.on('exit', lost);
  // After the listeners: adding a 'message' listener holds the process open again.
  worker.unref();
  return helper;
}

if (!isMainThread && (workerData as { tag?: string } | null)?.tag === TAG) {
  parentPort!.on('message', ({ id, code }: { id: number; code: string }) => parentPort!.postMessage({ id, out: contextAwaits(code) }));
}
