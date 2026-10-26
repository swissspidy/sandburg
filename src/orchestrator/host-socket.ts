/**
 * The runtime's file requests over a WebSocket: the host's end of the file channel (its wire
 * format: src/file-channel.ts; the runtime's end: src/node-runtime/host-files.ts).
 *
 * A runtime's synchronous XMLHttpRequest for an installed file costs ~5-7 ms in the browser, most of
 * it Playwright's request interception (every request of a routed context makes a round trip to
 * Playwright), for a file the host has in memory. A WebSocket's messages are not intercepted: the
 * runtime's helper worker asks over one, and the runtime waits on shared memory, ~0.5 ms a request.
 *
 * Posted: esbuild's transforms (src/adapters/node/native-transform.ts, asynchronous requests that
 * over HTTP took 15-60 ms each) and the runtime's compiles (hostCompile in node-runtime/worker.ts,
 * synchronous, ~7-10 ms each over HTTP). An answer over MAX_BODY is status 0: the runtime asks again
 * over HTTP, and the host compiles again (from its cache of compiles, by digest).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostRequest, HostResponse } from '../types.ts';
import { traceTransfer } from '../transfer-trace.ts';
import { ANSWER_HEADER, MAX_BODY, MAX_FRAGMENTS, MAX_FRAME, MAX_POST, POST_HEADER } from '../file-channel.ts';

/** The paths a runtime asks for over the channel: installed files. */
const SERVED = /^\/__sandburg\/nm\//;
/** The paths it posts to: esbuild's transforms, and the runtime's compiles. */
const POSTED = /^\/__sandburg\/(?:esbuild-transform|compile)$/;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/**
 * What one channel may hold of answers not sent yet, counting each request in progress as an answer
 * of MAX_BODY (what it may add): a request is taken only while it fits, so at most 8 are in
 * progress, and what waits to be sent stays under MAX_UNSENT (plus frame headers and a pong).
 */
export const MAX_UNSENT = 8 << 20;
/** Requests one channel may have in progress, notes (id 0, not answered) among them. */
const MAX_IN_PROGRESS = 64;
/** A channel whose answers have not drained this long (its client does not read) is closed. */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Accepts the upgrade if it comes from `origin` (a WebSocket is not bound by CORS: another page could
 * open one to any host) and answers requests with `serve`. Returns whether the upgrade was accepted.
 */
export function acceptFileChannel(req: IncomingMessage, socket: Duplex, origin: string, serve: (req: HostRequest) => Promise<HostResponse | null>, options: { drainTimeoutMs?: number } = {}): boolean {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.origin !== origin || typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return false;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
  socket.on('error', () => socket.destroy());
  const channel = {};
  // A client that sends requests and does not read the answers is not answered without bound: a
  // request is read only while what waits to be sent, and MAX_BODY for each request in progress and
  // for it, fit in MAX_UNSENT; otherwise the socket is paused (TCP holds the client back) until
  // answers go out. Answers that do not drain within the timeout close the channel (and free its slot:
  // a client that ends its side while the socket is paused is not read until then).
  /** Requests in progress, and those of them that will be answered (notes are not). */
  let inFlight = 0;
  let answering = 0;
  let stalled: ReturnType<typeof setTimeout> | null = null;
  const send = (data: Buffer) => {
    if (socket.destroyed || socket.writableEnded) return;
    if (!socket.write(data) && !stalled) arm(sent());
  };
  /** Bytes that left the socket's buffer (net.Socket's bytesWritten counts what is still buffered too). */
  const sent = () => ((socket as Duplex & { bytesWritten?: number }).bytesWritten ?? 0) - socket.writableLength;
  // On expiry: still not drained, and nothing sent since the timer was armed: closed. A client that
  // reads, more slowly than the host writes, is given another period. (Progress is counted per write
  // the socket completes, and one write may hold the whole backlog: in effect a client must read at
  // least ~MAX_UNSENT per DRAIN_TIMEOUT_MS, ~280 KB/s.)
  const arm = (from: number) => {
    stalled = setTimeout(() => {
      stalled = null;
      if (!socket.writableNeedDrain) return;
      if (sent() > from) arm(sent());
      else socket.destroy();
    }, options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    stalled.unref?.();
  };
  const unstall = () => {
    if (stalled) clearTimeout(stalled);
    stalled = null;
  };
  socket.on('close', unstall);
  const reader = readFrames(socket, () => inFlight < MAX_IN_PROGRESS && socket.writableLength + (answering + 1) * MAX_BODY <= MAX_UNSENT, (opcode, payload) => {
    if (opcode === 0x8) return void socket.end(frame(0x8, Buffer.alloc(0)));
    if (opcode === 0x9) return send(frame(0xa, payload));
    if (opcode !== 0x1 && opcode !== 0x2) return;
    const t0 = performance.now();
    // A note (id 0: what the runtime read, or used of what came ahead; it does not read the answer)
    // is served and not answered. Only those two: any other request is answered, and reserved for.
    const note = opcode === 0x1 && isNote(payload);
    inFlight++;
    if (!note) answering++;
    const reply = (id: number, what: string) => (res: { status: number; body: Buffer }) => {
      inFlight--;
      if (note) return reader.resume();
      answering--;
      const head = Buffer.alloc(ANSWER_HEADER);
      head.writeUInt32LE(id >>> 0, 0);
      head.writeUInt32LE(res.status, 4);
      send(frame(0x2, Buffer.concat([head, res.body])));
      reader.resume();
      traceTransfer({ hop: 'host→runtime ws', what, bytes: res.body.length, encoding: 'binary', ms: performance.now() - t0 });
    };
    if (opcode === 0x2) {
      if (payload.length < POST_HEADER || POST_HEADER + payload.readUInt32LE(4) > payload.length) return void socket.destroy();
      const length = payload.readUInt32LE(4);
      const target = payload.subarray(POST_HEADER, POST_HEADER + length).toString('utf8');
      return void answerPost(target, payload.subarray(POST_HEADER + length), serve, channel).then(reply(payload.readUInt32LE(0), traced(target)));
    }
    const text = payload.toString('utf8');
    const space = text.indexOf(' ');
    void answer(text.slice(space + 1), serve, channel).then(reply(Number(text.slice(0, space)), text.slice(space + 1)));
  });
  socket.on('drain', () => (unstall(), reader.resume()));
  return true;
}

/** The runtime's notes: `0 <base>/nm/<install>/read?files=…` and `0 <base>/nm/<install>/<f|t>/<path>?used=1`, nothing else. */
function isNote(payload: Buffer): boolean {
  if (payload[0] !== 0x30 || payload[1] !== 0x20) return false;
  // Decided on the URL as it is served (its path and query), not on the request's text.
  let url: URL;
  try {
    url = new URL(payload.subarray(2).toString('utf8'), 'http://x');
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (/^\/__sandburg\/nm\/[0-9a-f]{24}\/read$/.test(url.pathname)) return [...url.searchParams.keys()].join() === 'files';
  return /^\/__sandburg\/nm\/[0-9a-f]{24}\/[ft]\/.+$/.test(url.pathname) && url.search === '?used=1';
}

/** A POST's target as traces show it: the compile cache's write token (a capability) left out. */
export function traced(target: string): string {
  return target.replace(/([?&]token=)[^&]*/, '$1…');
}

async function answerPost(target: string, body: Buffer, serve: (req: HostRequest) => Promise<HostResponse | null>, channel: object): Promise<{ status: number; body: Buffer }> {
  const empty = Buffer.alloc(0);
  try {
    const url = new URL(target, 'http://x');
    if (!POSTED.test(url.pathname)) return { status: 0, body: empty };
    const read = async (max?: number) => {
      if (max !== undefined && body.length > max) throw Object.assign(new Error('body too large'), { status: 413 });
      return body;
    };
    // The compile route's write capability, a header over HTTP, is in the query here (no headers).
    const token = url.searchParams.get('token') ?? undefined;
    url.searchParams.delete('token');
    const out = await serve({ method: 'POST', path: url.pathname, query: url.searchParams, headers: { 'x-sandburg-token': token }, body: read, channel });
    if (!out) return { status: 404, body: empty };
    const answer = typeof out.body === 'string' ? Buffer.from(out.body) : Buffer.from(out.body.buffer, out.body.byteOffset, out.body.byteLength);
    return answer.length > MAX_BODY ? { status: 0, body: empty } : { status: out.status, body: answer };
  } catch {
    return { status: 0, body: empty };
  }
}

async function answer(target: string, serve: (req: HostRequest) => Promise<HostResponse | null>, channel: object): Promise<{ status: number; body: Buffer }> {
  const empty = Buffer.alloc(0);
  try {
    const url = new URL(target, 'http://x');
    if (!SERVED.test(url.pathname)) return { status: 0, body: empty };
    const out = await serve({ method: 'GET', path: url.pathname, query: url.searchParams, body: async () => empty, channel });
    if (!out) return { status: 404, body: empty };
    const body = typeof out.body === 'string' ? Buffer.from(out.body) : Buffer.from(out.body.buffer, out.body.byteOffset, out.body.byteLength);
    return body.length > MAX_BODY ? { status: 0, body: empty } : { status: out.status, body };
  } catch {
    return { status: 0, body: empty };
  }
}

/**
 * Calls `onMessage` for each complete message from the client (masked frames). A data message may
 * come in fragments (a frame without FIN, then continuation frames): Chromium splits larger ones
 * (here, messages over ~131 KB). The pieces are put together, and a message larger than its kind
 * may be (MAX_FRAME for text, MAX_POST for binary), or in more than MAX_FRAGMENTS pieces, closes the
 * channel as soon as it is: what the host holds for a message is bounded in fragments as in bytes.
 * Control frames (close, ping) may come between the fragments.
 */
function readFrames(socket: Duplex, ready: () => boolean, onMessage: (opcode: number, payload: Buffer) => void): { resume(): void } {
  // What came and is not read yet, as it came: put together once it holds `need` bytes (the next
  // frame's header, or the whole frame once its header is read), so a large frame that comes in many
  // chunks is copied once, not once per chunk.
  let chunks: Buffer[] = [];
  let pending = 0;
  let need = 2;
  /** The data message being received in fragments: its opcode, the fragments, their length. */
  let message: { opcode: number; parts: Buffer[]; length: number } | null = null;
  /** A close frame came: nothing after it is read. */
  let closed = false;
  /** Frames are waiting until `ready` (the socket is paused meanwhile). */
  let held = false;
  const fail = () => {
    chunks = [];
    pending = 0;
    message = null;
    socket.destroy();
  };
  const read = () => {
    let buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, pending);
    chunks = [];
    pending = 0;
    need = 2;
    for (;;) {
      if (buf.length < 2) break;
      if (!ready()) {
        held = true;
        socket.pause();
        break;
      }
      let length = buf[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buf.length < 4) {
          need = 4;
          break;
        }
        length = buf.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buf.length < 10) {
          need = 10;
          break;
        }
        length = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const control = opcode >= 0x8;
      const continuation = opcode === 0x0;
      // A continuation without a message, a new message before the last ended, or a fragmented control frame.
      if (control ? !fin || length > 125 : continuation !== (message !== null)) return fail();
      // What the message holds so far, and this frame (a fragment of it, unless it is a whole one):
      // bounded in bytes, and in fragments.
      const received = continuation ? message!.length : 0;
      if (!control && received + length > ((continuation ? message!.opcode : opcode) === 0x2 ? MAX_POST : MAX_FRAME)) return fail();
      if (continuation && message!.parts.length >= MAX_FRAGMENTS) return fail();
      const masked = (buf[1] & 0x80) !== 0;
      const end = at + (masked ? 4 : 0) + length;
      if (buf.length < end) {
        need = end;
        break;
      }
      const payload = Buffer.from(buf.subarray(end - length, end));
      if (masked) {
        const mask = buf.subarray(at, at + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(end);
      if (opcode === 0x8) {
        // The client's last frame: what came after it, and a message it left unfinished, are dropped.
        closed = true;
        chunks = [];
        pending = 0;
        message = null;
        onMessage(opcode, payload);
        return;
      }
      if (control) {
        onMessage(opcode, payload);
      } else if (!fin) {
        message ??= { opcode, parts: [], length: 0 };
        message.parts.push(payload);
        message.length += length;
      } else if (message) {
        const whole = Buffer.concat([...message.parts, payload]);
        const kindOf = message.opcode;
        message = null;
        onMessage(kindOf, whole);
      } else {
        onMessage(opcode, payload);
      }
      if (socket.destroyed) return;
    }
    if (buf.length) {
      chunks = [buf];
      pending = buf.length;
    }
  };
  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    chunks.push(chunk);
    pending += chunk.length;
    if (!held && pending >= need) read();
  });
  return {
    resume() {
      if (!held || closed || socket.destroyed || !ready()) return;
      held = false;
      socket.resume();
      if (pending >= need) read();
    },
  };
}

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  let head: Buffer;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) {
    head = Buffer.from([0x80 | opcode, 126, 0, 0]);
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}
