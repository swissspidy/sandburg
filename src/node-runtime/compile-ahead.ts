/**
 * Compiles ahead: CommonJS files a program writes where it loads them from soon after (next dev's
 * server chunks, under the directories the adapter names), sent to the host's compiler as they are
 * written, by a helper worker, while the program goes on (next dev compiles the client next). When
 * the program requires one, the host's output is there: a cold run waited ~0.5 s for the host to
 * lower the page's server chunks, and a warm one fetched them (2.5 MB each, ~50 ms) by digest.
 *
 * The helper sends what the runtime would (worker.ts, hostCompile): the file's bytes, compiled as
 * CommonJS for its path, looked up by the digest the host keys its compiles with first. The output is
 * used only for the bytes it was compiled from (the file as written, unchanged since).
 */
import { NEEDS_LOWERING } from './loader.ts';
import type { Vfs } from './vfs.ts';
import { traceTransfer } from '../transfer-trace.ts';

const HELPER = `onmessage = async ({ data: { alive, path, bytes, shared, compiled, compile, token } }) => {
  if (alive) return void Atomics.store(new Int32Array(alive), 0, 1);
  const state = new Int32Array(shared, 0, 2);
  const settle = (status, out) => {
    if (out) {
      if (8 + out.length > shared.byteLength) shared.grow(8 + out.length);
      new Uint8Array(shared, 8, out.length).set(out);
    }
    Atomics.store(state, 1, out ? out.length : 0);
    Atomics.store(state, 0, status);
    Atomics.notify(state, 0);
  };
  try {
    const prefix = new TextEncoder().encode('cjs\\0' + path + '\\0');
    const keyed = new Uint8Array(prefix.length + bytes.length);
    keyed.set(prefix);
    keyed.set(bytes, prefix.length);
    let hex = '';
    for (const b of new Uint8Array(await crypto.subtle.digest('SHA-256', keyed))) hex += b.toString(16).padStart(2, '0');
    let res = await fetch(compiled + hex);
    if (res.status !== 200) res = await fetch(compile, { method: 'POST', headers: token ? { 'x-sandburg-token': token } : {}, body: new Blob([bytes]) });
    if (res.status !== 200) return settle(2, null);
    settle(1, new Uint8Array(await res.arrayBuffer()));
  } catch {
    settle(2, null);
  }
};`;

/** The largest output kept: a larger one is compiled when the program asks for it, as without this. */
const MAX_OUT = 64 << 20;

/** How long the program waits for a compile the helper has not finished (the host may be compiling it). */
const WAIT_MS = 30_000;

/** The browser's own, captured before the runtime hides them (worker_threads' Worker, no location). */
const NativeWorker = globalThis.Worker;
const workerHref = globalThis.location?.href;

let dirs: string[] = [];
/** What the runtime gave it (worker.ts' init): its files, the host's base URL, the run's compile capability. */
let vfs: Vfs;
let base = '';
let compileCache: { key: string; token?: string } | null = null;
let helper: Worker | null | undefined;
/**
 * Set once the helper runs. A worker this runtime starts does not start while the runtime blocks, so
 * the runtime never waits for one that has not: Pages Router chunks are required as soon as written.
 */
const alive = new Int32Array(new SharedArrayBuffer(4));
const pending = new Map<string, { data: Uint8Array; shared: SharedArrayBuffer }>();
const toSend = new Set<string>();
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

/** Compiles ahead the CommonJS files written under `under` (absolute directories). */
export function compileAhead(under: string[], runtime: { vfs: Vfs; base: string; compileCache: { key: string; token?: string } | null }): void {
  ({ vfs, base, compileCache } = runtime);
  dirs = under.map((d) => (d.endsWith('/') ? d : `${d}/`));
  // Started now, to be running by the program's first write.
  startHelper();
}

/** A file was written: sent once the program's current task ends (a chunk is written in pieces). */
export function compileWhenWritten(path: string): void {
  if (!dirs.length || !path.endsWith('.js') || !dirs.some((d) => path.startsWith(d))) return;
  if (!toSend.size) nativeSetTimeout(send);
  toSend.add(path);
}

function startHelper(): Worker | null {
  if (helper !== undefined) return helper;
  try {
    helper = new NativeWorker(URL.createObjectURL(new Blob([HELPER], { type: 'text/javascript' })));
    helper.postMessage({ alive: alive.buffer });
  } catch {
    helper = null;
  }
  return helper;
}

function send(): void {
  const paths = [...toSend];
  toSend.clear();
  // Never the program's error: a file that is not sent is compiled when the program asks for it.
  try {
    for (const path of paths) sendOne(path);
  } catch {
    // as without compiling ahead
  }
}

function sendOne(path: string): void {
  let data: Uint8Array;
  try {
    data = vfs.read(path);
  } catch {
    return;
  }
  // As the loader decides (loader.ts): a byte order mark is stripped before compiling, and code
  // without these is not compiled at all.
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return;
  if (!NEEDS_LOWERING.test(new TextDecoder().decode(data))) return;
  const worker = startHelper();
  if (!worker) return;
  const shared = new SharedArrayBuffer(8, { maxByteLength: 8 + MAX_OUT });
  const origin = new URL(base, workerHref).href;
  const compile = `${origin}/compile?kind=cjs&path=${encodeURIComponent(path)}${compileCache ? `&cache=${compileCache.key}` : ''}`;
  // A copy (the helper hashes and sends it; the file's own bytes stay the program's).
  worker.postMessage({ path, bytes: data.slice(), shared, compiled: `${origin}/compiled/`, compile, token: compileCache?.token ?? null });
  pending.set(path, { data, shared });
}

/**
 * The host's output for a CommonJS file the helper compiled ahead, if the program's code is that file
 * as it was written (unchanged since); waits for a compile still going. Null otherwise.
 */
export function compiledAhead(path: string): string | null {
  if (toSend.has(path)) send();
  const entry = pending.get(path);
  if (!entry) return null;
  pending.delete(path);
  if (Atomics.load(alive, 0) !== 1) return null;
  try {
    if (vfs.read(path) !== entry.data) return null;
  } catch {
    return null;
  }
  const state = new Int32Array(entry.shared, 0, 2);
  const t0 = performance.now();
  if (Atomics.wait(state, 0, 0, WAIT_MS) === 'timed-out' || Atomics.load(state, 0) !== 1) return null;
  traceTransfer({ hop: 'runtime waits for compile ahead', what: path, bytes: Atomics.load(state, 1), encoding: 'shared', ms: performance.now() - t0 });
  // Decoders do not read shared memory.
  return new TextDecoder().decode(new Uint8Array(entry.shared, 8, Atomics.load(state, 1)).slice());
}
