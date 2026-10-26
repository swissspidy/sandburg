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

let writer: Worker | null = null;
let ids = 0;
const waiting = new Map<number, (ok: boolean) => void>();

/** Writes `body` to `file` atomically, on the writer's thread; resolves true once it is there, false if it could not be written. */
export function writeSoon(file: string, body: string | Uint8Array): Promise<boolean> {
  return new Promise((done) => {
    try {
      writer ??= startWriter();
      const id = ++ids;
      waiting.set(id, done);
      // Held open while it has writes (a process that ends meanwhile would lose them), not after.
      if (waiting.size === 1) writer.ref();
      writer.postMessage({ id, file, body });
    } catch {
      done(false);
    }
  });
}

function startWriter(): Worker {
  const w = new Worker(new URL(import.meta.url), { workerData: { tag: TAG } });
  w.unref();
  w.on('message', ({ id, ok }: { id: number; ok: boolean }) => {
    waiting.get(id)?.(ok);
    waiting.delete(id);
    if (!waiting.size) w.unref();
  });
  // A writer that fails: what it had is not written (a later process writes it again), the next write starts another.
  const lost = () => {
    if (writer === w) writer = null;
    for (const done of waiting.values()) done(false);
    waiting.clear();
  };
  w.on('error', lost);
  w.on('exit', lost);
  return w;
}

/** Directories the writer made or found (a cache's 256 fan-out directories, made once each). */
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
