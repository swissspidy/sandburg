/**
 * Synchronous child processes (execSync, spawnSync, execFileSync; ADR 0063). The parent blocks in
 * Atomics.wait until the child exits, so the child cannot reach it with postMessage: its file
 * system calls, its output and its exit go through one shared buffer (the channel) instead, which
 * the parent serves while it waits. The child's worker is started by the runtime's helper worker
 * (host-files.ts), which is not blocked: a worker this thread started would not get its init
 * message before this thread runs a task again.
 *
 * The channel: a growable SharedArrayBuffer, a header of Int32 slots and the data after it. The
 * child writes a request (its kind, the bytes) and raises STATE to 1; the parent answers (status,
 * kind, bytes) and sets it to 2; the child reads the answer and sets it back to 0. Only the child's
 * own thread makes requests (its threads and children reach the parent through it). The helper
 * raises DEAD if the child's worker fails.
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
/** Request kinds. */
const VFS = 1;
const STDOUT = 2;
const STDERR = 3;
const EXIT = 4;
const MAX_CHANNEL = 1 << 30;

/** A new channel for a synchronous child (address space for MAX_CHANNEL is reserved, not memory). */
export function syncChannel(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER + (1 << 16), { maxByteLength: HEADER + MAX_CHANNEL });
}

function put(sab: SharedArrayBuffer, bytes: Uint8Array): void {
  if (HEADER + bytes.length > sab.byteLength) sab.grow(Math.min(HEADER + MAX_CHANNEL, Math.max(HEADER + bytes.length, sab.byteLength * 2)));
  new Uint8Array(sab, HEADER, bytes.length).set(bytes);
}

/** The helper's code that marks a channel dead (its worker failed): raises DEAD and wakes the parent. */
export const MARK_DEAD = `(sab) => { const h = new Int32Array(sab, 0, ${HEADER / 4}); Atomics.store(h, ${DEAD}, 1); Atomics.notify(h, ${STATE}); }`;

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
    if (Atomics.load(h, DEAD)) return { crashed: true };
    const state = Atomics.load(h, STATE);
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
    } else if (kind === STDOUT || kind === STDERR) {
      if (!output(kind === STDOUT ? 1 : 2, decoder.decode(bytes))) end = { overflow: true };
    } else if (kind === EXIT) end = { code: Number(decoder.decode(bytes)) };
    put(sab, answer.bytes);
    h[ANSWER_STATUS] = answer.status;
    h[ANSWER_KIND] = answer.kind;
    h[ANSWER_LENGTH] = answer.bytes.length;
    Atomics.store(h, STATE, 2);
    Atomics.notify(h, STATE);
    if (end) return end;
  }
}

/** A file system call's operation and arguments: JSON, with the one byte array a write has after it. */
function encodeCall(op: VfsOp, args: unknown[]): Uint8Array {
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
  const request = (kind: number, bytes: Uint8Array): VfsAnswer => {
    put(sab, bytes);
    h[KIND] = kind;
    h[LENGTH] = bytes.length;
    Atomics.store(h, STATE, 1);
    Atomics.notify(h, STATE);
    while (Atomics.load(h, STATE) === 1) Atomics.wait(h, STATE, 1);
    const answer = { status: h[ANSWER_STATUS], kind: h[ANSWER_KIND], bytes: new Uint8Array(sab, HEADER, h[ANSWER_LENGTH]).slice() };
    Atomics.store(h, STATE, 0);
    return answer;
  };
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    request(EXIT, encoder.encode(String(code)));
  };
  return (msg) => {
    if (exited) return;
    if (msg.type === 'vfs-rpc') writeVfsAnswer(msg.sab, request(VFS, encodeCall(msg.op, msg.args)));
    else if (msg.type === 'log') request(msg.stream === 'stdout' ? STDOUT : STDERR, encoder.encode(msg.text));
    else if (msg.type === 'exit') exit(Number(msg.code ?? 0));
    else if (msg.type === 'fatal') {
      request(STDERR, encoder.encode(`${msg.stack ?? msg.message}\n`));
      exit(1);
    }
  };
}
