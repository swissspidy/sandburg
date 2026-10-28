/**
 * The channel between a synchronous child process and its blocked parent (node-runtime/sync-child.ts),
 * and the helper's side of starting and ending children (SPAWN_HELPER), in Node: Atomics and shared
 * memory behave as in the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARK_DEAD, SPAWN_HELPER, encodeCall, serveSyncChild, syncChannel, syncParent } from '../../src/node-runtime/sync-child.ts';
import { Vfs } from '../../src/node-runtime/vfs.ts';

const markDead = new Function(`return ${MARK_DEAD}`)() as (sab: SharedArrayBuffer) => void;
const noFiles = () => new Vfs(() => {
  throw new Error('no remote files');
});

test('a child marked dead between the parent\'s check and its wait wakes the parent (no lost wakeup)', () => {
  const sab = syncChannel();
  const wait = Atomics.wait;
  const slept: string[] = [];
  // The helper marks the child dead just as the parent goes to sleep: after it looked, before it waits.
  Atomics.wait = ((array: Int32Array, index: number, value: number, timeout?: number) => {
    if (!slept.length) markDead(sab);
    const result = wait(array, index, value, Math.min(timeout ?? Infinity, 1000));
    slept.push(result);
    return result;
  }) as typeof Atomics.wait;
  try {
    assert.deepEqual(serveSyncChild(sab, noFiles(), Infinity, () => true), { crashed: true });
  } finally {
    Atomics.wait = wait;
  }
  assert.deepEqual(slept, ['not-equal'], 'the parent slept although the child was dead');
});

/** The helper's side, with workers that record what happens to them. */
function helper() {
  const workers: { url: string; init: unknown; terminated: boolean; onerror: ((e: object) => void) | null; postMessage(init: unknown): void; terminate(): void }[] = [];
  class FakeWorker {
    url: string;
    init: unknown = null;
    terminated = false;
    onerror: ((e: object) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      workers.push(this);
    }
    postMessage(init: unknown) {
      this.init = init;
    }
    terminate() {
      this.terminated = true;
    }
  }
  const message = new Function('Worker', `${SPAWN_HELPER}\nreturn spawnerMessage;`)(FakeWorker) as (data: unknown, from: string | null) => boolean;
  type Send = (data: unknown) => void;
  const root: Send = (data) => message(data, 'root');
  /** A runtime's spawner port, registered by `parent` (root by default): what is sent on it arrives as from that runtime. */
  const port = (owner: string, parent: Send = root): Send => {
    const p: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
    parent({ spawnerPort: p, owner });
    return (data) => p.onmessage?.({ data });
  };
  return { message, port, workers };
}
const dead = (sab: SharedArrayBuffer) => Atomics.load(new Int32Array(sab), 3) === 1;
const RUNTIME = 'http://localhost/__sandburg/node-worker.js';

test("the helper starts only the runtime's script the main runtime named, for the child's own parent", () => {
  const { message, port, workers } = helper();
  // No runtime named yet: refused, and the parent is told (not left waiting).
  const early = syncChannel();
  port('a');
  message({ spawn: 'a', init: {}, sync: early }, 'root');
  assert.ok(dead(early));
  // A child runtime cannot name another script; the main runtime names it once.
  const fromChild = port('b');
  fromChild({ runtime: 'http://localhost/evil.js' });
  message({ runtime: RUNTIME }, 'root');
  message({ runtime: 'http://localhost/other.js' }, 'root');
  // Only the runtime that registered a child's port may start it.
  const notParent = syncChannel();
  port('c');
  fromChild({ spawn: 'c', init: {}, sync: notParent });
  assert.ok(dead(notParent));
  // A spawn without a channel, or with a bad one, is dropped (no one waits on it).
  assert.equal(message({ spawn: 'c', init: {}, sync: 'not memory' }, 'root'), true);
  assert.equal(workers.length, 0);
  const ok = syncChannel();
  message({ spawn: 'c', init: { type: 'init' }, sync: ok }, 'root');
  assert.deepEqual(workers.map((w) => [w.url, w.init]), [[RUNTIME, { type: 'init' }]]);
  assert.ok(!dead(ok));
  // A file channel port's messages (from null) are not the spawner's.
  assert.equal(message({ spawn: 'c' }, null), false);
});

test("a child's worker that fails marks its channel dead, and its parent stops waiting (crashed)", () => {
  const { message, port, workers } = helper();
  message({ runtime: RUNTIME }, 'root');
  port('a');
  const sab = syncChannel();
  message({ spawn: 'a', init: {}, sync: sab }, 'root');
  workers[0].onerror!({ preventDefault() {} });
  assert.ok(workers[0].terminated);
  assert.deepEqual(serveSyncChild(sab, noFiles(), Infinity, () => true), { crashed: true });
});

test("ending a child ends the runtimes under it, synchronous grandchildren too, and forgets them", () => {
  const { message, port, workers } = helper();
  message({ runtime: RUNTIME }, 'root');
  const a = port('a');
  message({ spawn: 'a', init: {}, sync: syncChannel() }, 'root');
  // a starts b (synchronously), b an asynchronous child c, which starts d synchronously.
  const b = port('b', a);
  a({ spawn: 'b', init: {}, sync: syncChannel() });
  const c = port('c', b);
  port('d', c);
  c({ spawn: 'd', init: {}, sync: syncChannel() });
  port('e');
  message({ spawn: 'e', init: {}, sync: syncChannel() }, 'root');
  // Only a runtime's parent may end it.
  a({ end: 'e' });
  assert.deepEqual(workers.map((w) => w.terminated), [false, false, false, false]);
  message({ end: 'a' }, 'root');
  assert.deepEqual(workers.map((w) => w.terminated), [true, true, true, false]);
  // Forgotten: the tags can be registered again.
  port('a');
  message({ spawn: 'a', init: {}, sync: syncChannel() }, 'root');
  assert.equal(workers.length, 5);
});

test("the channel's limits: a payload larger than it is an EFBIG error on either side, not a RangeError", () => {
  const sab = syncChannel(1024);
  // The child's side: a write too large for the channel fails the write (the parent is not asked).
  const post = syncParent(sab);
  const answer = new SharedArrayBuffer(16 + 4096);
  post({ type: 'vfs-rpc', sab: answer, op: 'write', args: ['/app/big', new Uint8Array(4096), false] });
  const header = new Int32Array(answer, 0, 4);
  assert.equal(header[0], 2);
  assert.match(new TextDecoder().decode(new Uint8Array(answer, 16, header[1])), /"code":"EFBIG"/);
  // The parent's side: a file too large to send back is an EFBIG answer.
  const vfs = noFiles();
  vfs.mkdir('/app', true);
  vfs.write('/app/big', new Uint8Array(4096));
  const request = encodeCall('read', ['/app/big']);
  const h = new Int32Array(sab, 0, 8);
  new Uint8Array(sab, 32, request.length).set(request);
  h[1] = 1;
  h[2] = request.length;
  Atomics.store(h, 0, 1);
  assert.deepEqual(serveSyncChild(sab, vfs, performance.now() + 50, () => true), { timedOut: true });
  assert.equal(h[4], 2);
  assert.match(new TextDecoder().decode(new Uint8Array(sab, 32, h[6]).slice()), /"code":"EFBIG".*read '\/app\/big'/);
});

test('a channel takes less address space where 1 GiB cannot be reserved', () => {
  const Native = globalThis.SharedArrayBuffer;
  globalThis.SharedArrayBuffer = class extends Native {
    constructor(length: number, options?: { maxByteLength?: number }) {
      if ((options?.maxByteLength ?? 0) > 1 << 27) throw new RangeError('Array buffer allocation failed');
      super(length, options);
    }
  } as SharedArrayBufferConstructor;
  try {
    assert.equal(syncChannel().maxByteLength, 32 + (1 << 26));
  } finally {
    globalThis.SharedArrayBuffer = Native;
  }
});

test("a runtime that was ended can start no child: its late messages are refused, and the child's parent is not left waiting", () => {
  const { message, port, workers } = helper();
  message({ runtime: RUNTIME }, 'root');
  // C's port and its messages arrive on their own channel: root's end can overtake C's spawn of G.
  const c = port('C');
  message({ spawn: 'C', init: {}, sync: syncChannel() }, 'root');
  message({ end: 'C' }, 'root');
  const g = { onmessage: null as ((e: { data: unknown }) => void) | null };
  c({ spawnerPort: g, owner: 'G' });
  const sync = syncChannel();
  c({ spawn: 'G', init: {}, sync });
  assert.deepEqual(workers.map((w) => w.terminated), [true], 'G started after C ended');
  assert.ok(dead(sync));
  assert.equal(g.onmessage, null, "an ended runtime's port registration is dropped");
});

test('a tag registered twice by the same runtime is refused loudly: its spawn marks the channel dead', () => {
  const { message, port, workers } = helper();
  message({ runtime: RUNTIME }, 'root');
  port('a');
  port('a');
  const sync = syncChannel();
  message({ spawn: 'a', init: {}, sync }, 'root');
  assert.equal(workers.length, 0);
  assert.ok(dead(sync));
  // Another runtime's tags are its own: a child registering 'b' does not take root's 'b'.
  const child = port('x');
  child({ spawnerPort: { onmessage: null }, owner: 'b' });
  port('b');
  const ok = syncChannel();
  message({ spawn: 'b', init: {}, sync: ok }, 'root');
  assert.equal(workers.length, 1);
  assert.ok(!dead(ok));
});
