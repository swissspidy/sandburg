/**
 * Synchronous child processes (execSync, spawnSync, execFileSync; ADR 0063). The parent blocks in
 * Atomics.wait until the child exits, so the child cannot reach it with postMessage: its file
 * system calls, its output and its exit go through one shared buffer (the channel) instead, which
 * the parent serves while it waits. The child's worker is started by the runtime's helper worker
 * (host-files.ts, SPAWN_HELPER below), which is not blocked: a worker this thread started would not
 * get its init message before this thread runs a task again.
 *
 * The channel: a growable SharedArrayBuffer, a header of Int32 slots and the data after it. The
 * child writes a request (its kind, the bytes) and raises STATE to 1; the parent answers (status,
 * kind, bytes) and sets it to 2; the child reads the answer and sets it back to 0. Only the child's
 * own thread makes requests (its threads and children reach the parent through it). The helper
 * marks the child dead (DEAD, and STATE 3) if its worker fails.
 */
import { vfsAnswer, writeVfsAnswer, type VfsAnswer } from './threads.ts';
import type { Vfs } from './vfs.ts';
import type { ToParent, VfsOp } from './messages.ts';

const STATE = 0;
const KIND = 1;
const LENGTH = 2;
const DEAD = 3;
const ANSWER_STATUS = 4;
const ANSWER_KIND = 5;
const ANSWER_LENGTH = 6;
const HEADER = 32;
/** STATE: the child's worker is gone (a value of its own, so that a parent about to wait on 0 or 2 does not sleep). */
const STATE_DEAD = 3;
/** Request kinds. */
const VFS = 1;
const STDOUT = 2;
const STDERR = 3;
const EXIT = 4;
/** The data's largest size: 1 GiB of address space, less where it cannot be reserved (32-bit). */
const MAX_DATA = [1 << 30, 1 << 28, 1 << 26, 1 << 24];
const START_DATA = 1 << 16;

/** A new channel for a synchronous child; `maxData` (tests) caps its data. */
export function syncChannel(maxData?: number): SharedArrayBuffer {
  for (const max of maxData ? [maxData] : MAX_DATA) {
    try {
      return new SharedArrayBuffer(HEADER + Math.min(START_DATA, max), { maxByteLength: HEADER + max });
    } catch {
      // Not that much address space: less.
    }
  }
  return new SharedArrayBuffer(HEADER + START_DATA);
}

const capacity = (sab: SharedArrayBuffer) => (sab.growable ? sab.maxByteLength : sab.byteLength) - HEADER;

/** Writes `bytes` into the channel's data, growing it; false if they do not fit. */
function put(sab: SharedArrayBuffer, bytes: Uint8Array): boolean {
  if (bytes.length > capacity(sab)) return false;
  if (HEADER + bytes.length > sab.byteLength) {
    try {
      sab.grow(Math.min(HEADER + capacity(sab), Math.max(HEADER + bytes.length, sab.byteLength * 2)));
    } catch {
      return false;
    }
  }
  new Uint8Array(sab, HEADER, bytes.length).set(bytes);
  return true;
}

/** A file system call's answer for a payload the channel cannot carry. */
function tooLarge(op: string, path: unknown, sab: SharedArrayBuffer): VfsAnswer {
  const message = `EFBIG: file too large for a synchronous child process's channel (${capacity(sab)} bytes at most), ${op} '${String(path)}'`;
  return { status: 2, kind: 0, bytes: new TextEncoder().encode(JSON.stringify({ code: 'EFBIG', syscall: op, path: String(path), message })) };
}

/** The helper's code that marks a channel dead (its worker failed): raises DEAD and STATE, and wakes the parent. */
export const MARK_DEAD = `(sab) => { const h = new Int32Array(sab, 0, ${HEADER / 4}); Atomics.store(h, ${DEAD}, 1); Atomics.store(h, ${STATE}, ${STATE_DEAD}); Atomics.notify(h, ${STATE}); }`;

/**
 * The helper's side (host-files.ts puts it in the helper's script): `spawnerMessage(data, from)`
 * handles a message about synchronous children, from the main runtime ('root') or the runtime that
 * owns a spawner port, and says whether it was one.
 *
 * Each runtime that may start synchronous children is a node of a tree, named by the tag of its
 * port, under the runtime that registered the port (`spawnerPort`). A runtime starts its child
 * (`spawn`, the tag of the port it gave the child) and ends it (`end`): the child's worker, and every
 * runtime under it, is terminated (a synchronous grandchild's worker is the helper's, not the
 * child's, and would outlive it). Only a node's parent may start or end it. Workers start the
 * runtime's script, which the main runtime names once (`runtime`), and nothing else.
 */
export const SPAWN_HELPER = `
let runtimeUrl = null;
const nodes = new Map();
const markDead = ${MARK_DEAD};
const end = (tag) => {
  for (const [t, node] of nodes) if (node.parent === tag) end(t);
  nodes.get(tag)?.worker?.terminate();
  nodes.delete(tag);
};
const spawnerMessage = (data, from) => {
  if (!data || from === null) return false;
  if (typeof data.runtime === 'string') {
    if (from === 'root') runtimeUrl ??= data.runtime;
    return true;
  }
  if (data.spawnerPort) {
    const owner = data.owner;
    if (typeof owner === 'string' && !nodes.has(owner)) {
      nodes.set(owner, { parent: from, worker: null });
      data.spawnerPort.onmessage = (e) => spawnerMessage(e.data, owner);
    }
    return true;
  }
  if (typeof data.spawn === 'string') {
    const node = nodes.get(data.spawn);
    const sync = data.sync instanceof SharedArrayBuffer && data.sync.byteLength >= ${HEADER} ? data.sync : null;
    if (!sync) return true;
    if (!node || node.parent !== from || node.worker || !runtimeUrl || !data.init || typeof data.init !== 'object') return markDead(sync), true;
    try {
      const worker = new Worker(runtimeUrl);
      node.worker = worker;
      worker.onerror = (e) => {
        e.preventDefault?.();
        end(data.spawn);
        markDead(sync);
      };
      worker.postMessage(data.init, Array.isArray(data.transfer) ? data.transfer : []);
    } catch {
      end(data.spawn);
      markDead(sync);
    }
    return true;
  }
  if (typeof data.end === 'string') {
    if (nodes.get(data.end)?.parent === from) end(data.end);
    return true;
  }
  return false;
};`;

// --- the parent's side --------------------------------------------------------------------------

export type SyncEnd = { code: number } | { timedOut: true } | { overflow: true } | { crashed: true };

/**
 * Serves a synchronous child's channel until it exits, `deadline` (performance.now()) passes, or
 * `output` returns false (maxBuffer). File system calls run on `vfs`.
 */
export function serveSyncChild(sab: SharedArrayBuffer, vfs: Vfs, deadline: number, output: (fd: 1 | 2, text: string) => boolean): SyncEnd {
  const h = new Int32Array(sab, 0, HEADER / 4);
  const decoder = new TextDecoder();
  for (;;) {
    const state = Atomics.load(h, STATE);
    if (state === STATE_DEAD || Atomics.load(h, DEAD)) return { crashed: true };
    if (state !== 1) {
      const left = deadline - performance.now();
      if (left <= 0) return { timedOut: true };
      Atomics.wait(h, STATE, state, left === Infinity ? undefined : left);
      continue;
    }
    const kind = h[KIND];
    // A copy: decoders do not read resizable memory.
    const bytes = new Uint8Array(sab, HEADER, h[LENGTH]).slice();
    let answer: VfsAnswer = { status: 1, kind: 0, bytes: new Uint8Array(0) };
    let end: SyncEnd | null = null;
    if (kind === VFS) {
      const { op, args } = decodeCall(bytes);
      answer = vfsAnswer(vfs, op, args);
      if (answer.bytes.length > capacity(sab)) answer = tooLarge(op, args[0], sab);
    } else if (kind === STDOUT || kind === STDERR) {
      if (!output(kind === STDOUT ? 1 : 2, decoder.decode(bytes))) end = { overflow: true };
    } else if (kind === EXIT) end = { code: Number(decoder.decode(bytes)) };
    if (!put(sab, answer.bytes)) {
      // Memory for it could not be had after all.
      answer = tooLarge(kind === VFS ? decodeCall(bytes).op : 'write', '', sab);
      put(sab, answer.bytes);
    }
    h[ANSWER_STATUS] = answer.status;
    h[ANSWER_KIND] = answer.kind;
    h[ANSWER_LENGTH] = answer.bytes.length;
    Atomics.store(h, STATE, 2);
    Atomics.notify(h, STATE);
    if (end) return end;
  }
}

/** A file system call's operation and arguments: JSON, with the one byte array a write has after it. */
export function encodeCall(op: VfsOp, args: unknown[]): Uint8Array {
  const data = args.find((a): a is Uint8Array => a instanceof Uint8Array);
  const json = new TextEncoder().encode(JSON.stringify({ op, args: args.map((a) => (a instanceof Uint8Array ? { $bytes: true } : a)) }));
  const out = new Uint8Array(4 + json.length + (data?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  if (data) out.set(data, 4 + json.length);
  return out;
}

function decodeCall(bytes: Uint8Array): { op: VfsOp; args: unknown[] } {
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const { op, args } = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as { op: VfsOp; args: unknown[] };
  return { op, args: args.map((a) => ((a as { $bytes?: boolean } | null)?.$bytes ? bytes.slice(4 + length) : a)) };
}

// --- the child's side ---------------------------------------------------------------------------

/**
 * What a synchronous child posts to its parent: its file system calls, output and exit go through
 * the channel; the rest (servers it announces, IPC) has no one to go to.
 */
export function syncParent(sab: SharedArrayBuffer): (msg: ToParent) => void {
  const h = new Int32Array(sab, 0, HEADER / 4);
  const encoder = new TextEncoder();
  let exited = false;
  /** The parent's answer, or null if the request does not fit the channel. */
  const request = (kind: number, bytes: Uint8Array): VfsAnswer | null => {
    if (!put(sab, bytes)) return null;
    h[KIND] = kind;
    h[LENGTH] = bytes.length;
    Atomics.store(h, STATE, 1);
    Atomics.notify(h, STATE);
    while (Atomics.load(h, STATE) === 1) Atomics.wait(h, STATE, 1);
    const answer = { status: h[ANSWER_STATUS], kind: h[ANSWER_KIND], bytes: new Uint8Array(sab, HEADER, h[ANSWER_LENGTH]).slice() };
    Atomics.store(h, STATE, 0);
    return answer;
  };
  /** Output in pieces the channel takes (a character is at most 3 bytes of UTF-8). */
  const log = (kind: number, text: string) => {
    const piece = Math.max(1, Math.floor(Math.min(capacity(sab), 1 << 20) / 3));
    for (let i = 0; i < text.length; i += piece) {
      // Not inside a surrogate pair.
      let to = Math.min(text.length, i + piece);
      if (to < text.length && to - i > 1 && /[\uD800-\uDBFF]/.test(text[to - 1])) to--;
      request(kind, encoder.encode(text.slice(i, to)));
      i = to - piece;
    }
  };
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    request(EXIT, encoder.encode(String(code)));
  };
  return (msg) => {
    if (exited) return;
    if (msg.type === 'vfs-rpc') writeVfsAnswer(msg.sab, request(VFS, encodeCall(msg.op, msg.args)) ?? tooLarge(msg.op, msg.args[0], sab));
    else if (msg.type === 'log') log(msg.stream === 'stdout' ? STDOUT : STDERR, msg.text);
    else if (msg.type === 'exit') exit(Number(msg.code ?? 0));
    else if (msg.type === 'fatal') {
      log(STDERR, `${msg.stack ?? msg.message}\n`);
      exit(1);
    }
  };
}
