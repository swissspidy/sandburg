/**
 * MessagePorts as in Node (worker_threads), on the browser's MessagePorts.
 *
 * - They are EventEmitters: 'message' listeners get the message itself (and start the port),
 *   with ref/unref and a 'close' event.
 * - receiveMessageOnPort() takes the next message synchronously, which tools do while their thread
 *   is blocked in Atomics.wait (Angular's Sass worker asking the main thread to resolve an import,
 *   synckit). A browser delivers messages only through its event loop, so each MessageChannel made
 *   here has a mailbox in shared memory as well: a sender writes each message it can encode as JSON
 *   there too, and numbers every message. receiveMessageOnPort() reads the mailbox; the event loop
 *   later skips what was read. A port's mailbox travels with it when it is transferred (see
 *   mailboxesFor/adoptMailboxes for thread envelopes, and the wrapped messages of ports).
 *
 * Messages that cannot be encoded as JSON (typed arrays, shared memory, ports) are delivered
 * through the event loop only; receiveMessageOnPort() stops at them, as it cannot deliver them.
 */
import { EventEmitter } from 'events';

/** A port's mailbox: the shared memory of its channel, and which of the two inboxes is this port's. */
interface Mailbox {
  sab: SharedArrayBuffer;
  side: 0 | 1;
}

const INBOX = 256 * 1024;
const HEADER = 8; // Int32 fields below
const H_WRITE = 0; // bytes written
const H_WRITTEN = 1; // entries written
const H_READ = 2; // entries read
const H_READ_AT = 3; // byte offset of the next entry to read
const H_SEQ = 4; // last sequence number given out (by the writer)
const H_FULL = 5; // the inbox is full: later messages go through the event loop only
const H_DONE = 6; // the last sequence number read or delivered
const GAP = -1; // an entry for a message that is not in the mailbox
const UNDEFINED = -2;

const MARK = '__sandburgPortMessage';
const mailboxes = new WeakMap<MessagePort, Mailbox>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function inbox(sab: SharedArrayBuffer, side: 0 | 1) {
  const base = side * INBOX;
  return { h: new Int32Array(sab, base, HEADER), data: new Uint8Array(sab, base + HEADER * 4, INBOX - HEADER * 4), view: new DataView(sab, base + HEADER * 4, INBOX - HEADER * 4) };
}

/** Whether JSON keeps a value as a structured clone would. */
function jsonSafe(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth > 32 || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.every((x) => jsonSafe(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as object).every((x) => jsonSafe(x, depth + 1));
}

/** Writes a message into the other side's inbox; returns its sequence number. */
function send(mb: Mailbox, message: unknown): number {
  const { h, data, view } = inbox(mb.sab, mb.side === 0 ? 1 : 0);
  const seq = Atomics.add(h, H_SEQ, 1) + 1;
  const body = message === undefined ? null : jsonSafe(message) ? encoder.encode(JSON.stringify(message)) : null;
  const size = 8 + (body ? (body.length + 3) & ~3 : 0);
  // Everything sent before this message was read or delivered: the inbox can start again from the top.
  const drained = Atomics.load(h, H_READ) === Atomics.load(h, H_WRITTEN) && Atomics.load(h, H_DONE) === seq - 1;
  if (drained && (Atomics.load(h, H_FULL) || Atomics.load(h, H_WRITE) + size > data.length)) {
    Atomics.store(h, H_READ_AT, 0);
    Atomics.store(h, H_WRITE, 0);
    Atomics.store(h, H_FULL, 0);
  }
  if (Atomics.load(h, H_FULL)) return seq;
  const at = Atomics.load(h, H_WRITE);
  if (at + size > data.length) {
    Atomics.store(h, H_FULL, 1);
    return seq;
  }
  view.setInt32(at, seq, true);
  view.setInt32(at + 4, body ? body.length : message === undefined ? UNDEFINED : GAP, true);
  if (body) data.set(body, at + 8);
  Atomics.store(h, H_WRITE, at + size);
  Atomics.add(h, H_WRITTEN, 1);
  return seq;
}

/** The next unread entry of a port's inbox. */
function peek(mb: Mailbox): { seq: number; length: number; at: number; size: number } | null {
  const { h, view } = inbox(mb.sab, mb.side);
  if (Atomics.load(h, H_READ) >= Atomics.load(h, H_WRITTEN)) return null;
  const at = Atomics.load(h, H_READ_AT);
  const length = view.getInt32(at + 4, true);
  return { seq: view.getInt32(at, true), length, at, size: 8 + (length > 0 ? (length + 3) & ~3 : 0) };
}

function consume(mb: Mailbox, entry: { seq: number; at: number; size: number }) {
  const { h } = inbox(mb.sab, mb.side);
  Atomics.store(h, H_READ_AT, entry.at + entry.size);
  Atomics.add(h, H_READ, 1);
  if (entry.seq > Atomics.load(h, H_DONE)) Atomics.store(h, H_DONE, entry.seq);
}

/** worker_threads.receiveMessageOnPort: the next message, if it can be taken synchronously. */
export function receiveMessageOnPort(port: MessagePort): { message: unknown } | undefined {
  const mb = mailboxes.get(port);
  const entry = mb && peek(mb);
  if (!mb || !entry || entry.length === GAP) return undefined;
  const { data } = inbox(mb.sab, mb.side);
  const message = entry.length === UNDEFINED ? undefined : JSON.parse(decoder.decode(data.slice(entry.at + 8, entry.at + 8 + entry.length)));
  consume(mb, entry);
  return { message };
}

/** A message that arrived through the event loop: false if receiveMessageOnPort() already took it. */
function arrived(port: MessagePort, seq: number): boolean {
  const mb = mailboxes.get(port);
  if (!mb || !seq) return true;
  const { h } = inbox(mb.sab, mb.side);
  if (seq <= Atomics.load(h, H_DONE)) return false;
  for (let e = peek(mb); e && e.seq <= seq; e = peek(mb)) consume(mb, e);
  Atomics.store(h, H_DONE, seq);
  return true;
}

const transferList = (t: unknown): Transferable[] => (Array.isArray(t) ? t : ((t as { transfer?: Transferable[] } | undefined)?.transfer ?? []));

/** The mailboxes of the ports in a transfer list, in order, for a message envelope (null: none). */
export function mailboxesFor(transfer: unknown): (Mailbox | null)[] | undefined {
  const ports = transferList(transfer).filter((t): t is MessagePort => t instanceof MessagePort);
  const list = ports.map((p) => mailboxes.get(p) ?? null);
  return list.some(Boolean) ? list : undefined;
}

/** Gives ports that arrived in a message (MessageEvent.ports, in transfer order) their mailboxes. */
export function adoptMailboxes(ports: readonly MessagePort[] | undefined, list: (Mailbox | null)[] | undefined): void {
  if (!ports || !list) return;
  list.forEach((mb, i) => mb && ports[i] && mailboxes.set(ports[i], mb));
}

/** A port message as sent: the message, its sequence number and the mailboxes of transferred ports. */
type Wrapped = { [MARK]: { seq: number; mailboxes?: (Mailbox | null)[] }; data: unknown };
const isWrapped = (d: unknown): d is Wrapped => typeof d === 'object' && d !== null && MARK in d;

/** A MessageChannel whose ports have mailboxes (when shared memory is available). */
function makeMessageChannel(Native: typeof MessageChannel): typeof MessageChannel {
  return class MessageChannel extends Native {
    constructor() {
      super();
      if (typeof SharedArrayBuffer === 'undefined') return;
      const sab = new SharedArrayBuffer(2 * INBOX);
      mailboxes.set(this.port1, { sab, side: 0 });
      mailboxes.set(this.port2, { sab, side: 1 });
    }
  };
}

/**
 * The browser's own MessageChannel and postMessage, for ports the runtime uses itself rather than the
 * program (the page's compiler, see worker.ts): plain messages, no Node semantics.
 */
export const NativeMessageChannel = globalThis.MessageChannel;
export const nativePostMessage = MessagePort.prototype.postMessage as (this: MessagePort, message: unknown, transfer: Transferable[]) => void;

export function installNodeMessagePorts(): void {
  const P = MessagePort.prototype as unknown as Record<string, unknown> & { __sandburg?: boolean };
  if (P.__sandburg) return;
  P.__sandburg = true;
  globalThis.MessageChannel = makeMessageChannel(globalThis.MessageChannel);

  // Sending: number the message, write it to the mailbox, pass on the mailboxes of transferred ports.
  const postMessage = MessagePort.prototype.postMessage as (this: MessagePort, message: unknown, transfer?: unknown) => void;
  P.postMessage = function (this: MessagePort, message: unknown, transfer?: unknown) {
    const mb = mailboxes.get(this);
    const boxes = mailboxesFor(transfer);
    if (!mb && !boxes) return postMessage.call(this, message, transfer);
    const wrapped: Wrapped = { [MARK]: { seq: mb ? send(mb, message) : 0, mailboxes: boxes }, data: message };
    return postMessage.call(this, wrapped, transfer);
  };

  // Receiving: every 'message' listener (and onmessage) gets the message as sent, once.
  const seen = new WeakMap<Event, MessageEvent | null>();
  const unwrap = (port: MessagePort, e: MessageEvent): MessageEvent | null => {
    if (seen.has(e)) return seen.get(e)!;
    let out: MessageEvent | null = e;
    if (isWrapped(e.data)) {
      const meta = e.data[MARK];
      adoptMailboxes(e.ports, meta.mailboxes);
      out = arrived(port, meta.seq) ? new MessageEvent('message', { data: e.data.data, ports: [...e.ports] }) : null;
    }
    seen.set(e, out);
    return out;
  };
  const wrappers = new WeakMap<object, EventListener>();
  type Listen = (this: MessagePort, type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) => void;
  const addEventListener = MessagePort.prototype.addEventListener as Listen;
  const removeEventListener = MessagePort.prototype.removeEventListener as Listen;
  P.addEventListener = function (this: MessagePort, type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) {
    if (type !== 'message' || !listener) return addEventListener.call(this, type, listener, options);
    let wrapper = wrappers.get(listener);
    if (!wrapper) {
      wrapper = function (this: MessagePort, e: Event) {
        const event = unwrap(this, e as MessageEvent);
        if (!event) return;
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      };
      wrappers.set(listener, wrapper);
    }
    return addEventListener.call(this, type, wrapper, options);
  };
  P.removeEventListener = function (this: MessagePort, type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) {
    return removeEventListener.call(this, type, (listener && wrappers.get(listener)) ?? listener, options);
  };
  const handlers = new WeakMap<MessagePort, EventListener>();
  Object.defineProperty(P, 'onmessage', {
    configurable: true,
    get(this: MessagePort) {
      return handlers.get(this) ?? null;
    },
    set(this: MessagePort, fn: EventListener | null) {
      const old = handlers.get(this);
      if (old) this.removeEventListener('message', old);
      if (fn) {
        handlers.set(this, fn);
        this.addEventListener('message', fn);
        this.start();
      } else handlers.delete(this);
    },
  });

  // EventEmitter methods.
  const emitters = new WeakMap<MessagePort, EventEmitter>();
  const emitterOf = (port: MessagePort) => {
    let em = emitters.get(port);
    if (!em) {
      const e = new EventEmitter();
      em = e;
      emitters.set(port, e);
      port.addEventListener('message', (m) => e.emit('message', (m as MessageEvent).data));
      port.addEventListener('messageerror', (m) => e.emit('messageerror', (m as MessageEvent).data));
    }
    return em;
  };
  type Fn = (...a: unknown[]) => unknown;
  for (const name of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'] as const) {
    P[name] = function (this: MessagePort, event: string, fn: Fn) {
      emitterOf(this)[name](event, fn);
      if (event === 'message') this.start();
      return this;
    };
  }
  for (const name of ['off', 'removeListener'] as const) {
    P[name] = function (this: MessagePort, event: string, fn: Fn) {
      emitters.get(this)?.[name](event, fn);
      return this;
    };
  }
  P.removeAllListeners = function (this: MessagePort, event?: string) {
    emitters.get(this)?.removeAllListeners(event);
    return this;
  };
  P.emit = function (this: MessagePort, event: string, ...args: unknown[]) {
    return emitters.get(this)?.emit(event, ...args) ?? false;
  };
  P.listenerCount = function (this: MessagePort, event: string) {
    return emitters.get(this)?.listenerCount(event) ?? 0;
  };
  P.listeners = function (this: MessagePort, event: string) {
    return emitters.get(this)?.listeners(event) ?? [];
  };
  P.ref = P.unref = function (this: MessagePort) {
    return this;
  };
  P.hasRef = () => true;
  // Node's BroadcastChannel has ref/unref too (the Nuxt CLI unrefs its error channel).
  const B = BroadcastChannel.prototype as unknown as Record<string, unknown>;
  const self = function (this: BroadcastChannel) {
    return this;
  };
  B.ref ??= self;
  B.unref ??= self;
  const close = MessagePort.prototype.close;
  P.close = function (this: MessagePort) {
    close.call(this);
    queueMicrotask(() => emitters.get(this)?.emit('close'));
  };
}
