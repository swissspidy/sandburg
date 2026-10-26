/**
 * The rewrite of awaits (node-runtime/await-context.ts: the scan and the parse check of its output)
 * for installed files, on a helper thread.
 *
 * On the host's main thread they took 0.25 s of a cold vite-react-counter start and 1.8-2.1 s of a
 * cold next-app-router one (the scan ~70%, the check the rest), while the runtime waited on the same
 * thread for its next file. Here the main thread only posts each file's code to a helper, which runs
 * the same contextAwaits (compiled with `Function`, never called, as on the main thread) and answers
 * its output, or null to lower. A helper that fails is not used again: its files, and later ones,
 * are rewritten on this thread, with the same result.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { contextAwaits } from '../../node-runtime/await-context.ts';

const TAG = 'sandburg-await-threads';

/** Code smaller than this is rewritten on this thread: posting a file costs ~0.03 ms, rewriting 1 KB ~0.1 ms. */
const INLINE_MAX = 1 << 10;

interface Helper {
  worker: Worker;
  /** It has loaded the scan (its first message). */
  ready: boolean;
  /** Its files not answered yet, by id: their code is kept, to be rewritten here if the helper fails. */
  waiting: Map<number, { code: string; done: (out: string | null) => void }>;
}

/**
 * One helper: the main thread, esbuild and the browser's threads need the other cores (with two, a
 * cold astro-app run on 4 cores was 11% slower than on main; with one, 4% faster). Started by the
 * first file it would take (a warm run, whose transforms are cached, starts none); until it is
 * ready (~90 ms, loading the scan), files are rewritten on this thread.
 */
let helper: Helper | null = null;
let ids = 0;
/** The helper failed: later rewrites are made on this thread (a helper that cannot start is not started again for each). */
let onThisThread = false;

/** contextAwaits(code), on the helper's thread when it is worth it. */
export function contextAwaitsSoon(code: string): Promise<string | null> {
  if (onThisThread || code.length < INLINE_MAX || !code.includes('await')) return Promise.resolve(contextAwaits(code));
  try {
    helper ??= startHelper();
  } catch {
    onThisThread = true;
  }
  if (!helper?.ready) return Promise.resolve(contextAwaits(code));
  const { worker, waiting } = helper;
  return new Promise((done) => {
    const id = ++ids;
    waiting.set(id, { code, done });
    // Held open while it has files (as the file writer is), not after.
    if (waiting.size === 1) worker.ref();
    worker.postMessage({ id, code });
  });
}

function startHelper(): Helper {
  const worker = new Worker(new URL(import.meta.url), { workerData: { tag: TAG } });
  const started: Helper = { worker, ready: false, waiting: new Map() };
  const { waiting } = started;
  worker.on('message', ({ id, out }: { id: number; out: string | null }) => {
    // The first message: the helper has loaded the scan.
    if (!id) return void (started.ready = true);
    waiting.get(id)?.done(out);
    waiting.delete(id);
    if (!waiting.size) worker.unref();
  });
  const lost = () => {
    onThisThread = true;
    if (helper === started) helper = null;
    for (const { code, done } of waiting.values()) done(contextAwaits(code));
    waiting.clear();
  };
  worker.on('error', lost);
  worker.on('exit', lost);
  // After the listeners: adding a 'message' listener holds the process open again.
  worker.unref();
  return started;
}

if (!isMainThread && (workerData as { tag?: string } | null)?.tag === TAG) {
  parentPort!.on('message', ({ id, code }: { id: number; code: string }) => parentPort!.postMessage({ id, out: contextAwaits(code) }));
  parentPort!.postMessage({ id: 0, out: null });
}
