/**
 * Small cache files the host writes while a run waits on it (transforms of installed files, compiles),
 * each atomically (a temporary file, then a rename), on a thread of their own.
 *
 * Written through fs/promises on the main thread, their open, write, close and rename took ~1.6 s of
 * the host's main thread in a cold astro-app run (~2,000 transforms; FileHandles and a promise per
 * step), while the runtime waited on the same thread for its next file. Written synchronously on the
 * main thread instead, the system calls themselves took ~1.2 s of it there (this machine's overlay
 * file system, beside the install's unpacking). Here the main thread only posts each file to the
 * writer, which writes it synchronously.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const TAG = 'sandburg-file-writes';

/** The writer and the writes it has, by id. */
let writer: { worker: Worker; waiting: Map<number, (ok: boolean) => void> } | null = null;
let ids = 0;
/** A writer failed: later writes are made on this thread (a writer that cannot start is not started again for each). */
let onThisThread = false;

/** Writes `body` to `file` atomically, on the writer's thread; resolves true once it is there, false if it could not be written. */
export function writeSoon(file: string, body: string | Uint8Array): Promise<boolean> {
  if (onThisThread) return Promise.resolve(writeNow(file, body));
  return new Promise((done) => {
    try {
      writer ??= startWriter();
      const { worker, waiting } = writer;
      const id = ++ids;
      waiting.set(id, done);
      // Held open while it has writes (a process that ends meanwhile would lose them), not after.
      if (waiting.size === 1) worker.ref();
      worker.postMessage({ id, file, body });
    } catch {
      onThisThread = true;
      done(writeNow(file, body));
    }
  });
}

function startWriter(): { worker: Worker; waiting: Map<number, (ok: boolean) => void> } {
  const worker = new Worker(new URL(import.meta.url), { workerData: { tag: TAG } });
  const waiting = new Map<number, (ok: boolean) => void>();
  worker.on('message', ({ id, ok }: { id: number; ok: boolean }) => {
    waiting.get(id)?.(ok);
    waiting.delete(id);
    if (!waiting.size) worker.unref();
  });
  // A writer that fails: its writes are not made (a later process makes them again), and later ones
  // are made on this thread.
  const lost = () => {
    onThisThread = true;
    if (writer?.worker === worker) writer = null;
    for (const done of waiting.values()) done(false);
    waiting.clear();
  };
  worker.on('error', lost);
  worker.on('exit', lost);
  // After the listeners: adding a 'message' listener holds the process open again.
  worker.unref();
  return { worker, waiting };
}

/** Directories the writer (or this thread, see onThisThread) made or found (a cache's 256 fan-out directories, made once each). */
const made = new Set<string>();

function writeNow(file: string, body: string | Uint8Array): boolean {
  const dir = dirname(file);
  // A name no other writer uses, even of the same file at the same time (another process).
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    if (!made.has(dir)) mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(tmp, body);
    } catch (e) {
      // The directory was removed since (a sweep): made again.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, body);
    }
    made.add(dir);
    renameSync(tmp, file);
    return true;
  } catch {
    made.delete(dir);
    try {
      rmSync(tmp, { force: true });
    } catch {
      // not there
    }
    return false;
  }
}

if (!isMainThread && (workerData as { tag?: string } | null)?.tag === TAG) {
  parentPort!.on('message', ({ id, file, body }: { id: number; file: string; body: string | Uint8Array }) => parentPort!.postMessage({ id, ok: writeNow(file, body) }));
}
