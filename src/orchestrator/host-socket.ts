/**
 * The runtime's file requests over a WebSocket (see FILE_CHANNEL in src/node-runtime/worker.ts).
 *
 * A runtime's synchronous XMLHttpRequest for an installed file costs ~5-7 ms in the browser, most of
 * it Playwright's request interception (every request of a routed context makes a round trip to
 * Playwright), for a file the host has in memory. A WebSocket's messages are not intercepted: the
 * runtime's helper worker asks over one, and the runtime waits on shared memory, ~0.5 ms a request.
 *
 * A request is a text message `<id> <path>?<query>`, a GET of that path from the sandbox's adapter;
 * the answer is a binary message: the id and the HTTP status (u32 little-endian each), then the body.
 * Status 0 means "ask over HTTP": the path is not one the channel serves, or its body is larger than
 * MAX_BODY (large bodies are faster over HTTP).
 *
 * A POST is a binary message: the id and the path's length (u32 little-endian each), the path, then the
 * body (at most MAX_POST bytes), answered the same way. Only esbuild's transforms are posted (see
 * src/adapters/node/native-transform.ts): an asynchronous request each, which over HTTP took 15-60 ms.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { HostRequest, HostResponse } from '../types.ts';
import { traceTransfer } from '../transfer-trace.ts';

export const FILE_CHANNEL_PATH = '/__sandburg/files';
/** Larger bodies are answered with status 0 (over a WebSocket, 40 MB took 4x as long as over HTTP). */
export const MAX_BODY = 1 << 20;
/** Larger frames from the client close the channel: a request is `<id> <path>`, and nothing is buffered beyond this. */
export const MAX_FRAME = 1 << 16;
/** Larger POST frames close the channel (a transform's code and options; the route's own bound is 4 MB). */
export const MAX_POST = (4 << 20) + MAX_FRAME;
/** The paths a runtime asks for over the channel: installed files. */
const SERVED = /^\/__sandburg\/nm\//;
/** The paths it posts to: esbuild's transforms. */
const POSTED = /^\/__sandburg\/esbuild-transform$/;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Accepts the upgrade if it comes from `origin` (a WebSocket is not bound by CORS: another page could
 * open one to any host) and answers requests with `serve`. Returns whether the upgrade was accepted.
 */
export function acceptFileChannel(req: IncomingMessage, socket: Duplex, origin: string, serve: (req: HostRequest) => Promise<HostResponse | null>): boolean {
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
  readFrames(socket, (opcode, payload) => {
    if (opcode === 0x8) return void socket.end(frame(0x8, Buffer.alloc(0)));
    if (opcode === 0x9) return void socket.write(frame(0xa, payload));
    if (opcode !== 0x1 && opcode !== 0x2) return;
    const t0 = performance.now();
    const reply = (id: number, what: string) => (res: { status: number; body: Buffer }) => {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(id >>> 0, 0);
      head.writeUInt32LE(res.status, 4);
      if (!socket.destroyed) socket.write(frame(0x2, Buffer.concat([head, res.body])));
      traceTransfer({ hop: 'host→runtime ws', what, bytes: res.body.length, encoding: 'binary', ms: performance.now() - t0 });
    };
    if (opcode === 0x2) {
      if (payload.length < 8 || 8 + payload.readUInt32LE(4) > payload.length) return void socket.destroy();
      const length = payload.readUInt32LE(4);
      const target = payload.subarray(8, 8 + length).toString('utf8');
      return void answerPost(target, payload.subarray(8 + length), serve, channel).then(reply(payload.readUInt32LE(0), target));
    }
    const text = payload.toString('utf8');
    const space = text.indexOf(' ');
    void answer(text.slice(space + 1), serve, channel).then(reply(Number(text.slice(0, space)), text.slice(space + 1)));
  });
  return true;
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
    const out = await serve({ method: 'POST', path: url.pathname, query: url.searchParams, body: read, channel });
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

/** Calls `onFrame` for each complete frame from the client (masked, unfragmented: what browsers send for these messages). */
function readFrames(socket: Duplex, onFrame: (opcode: number, payload: Buffer) => void): void {
  let buf: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      let length = buf[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (length > ((buf[0] & 0x0f) === 0x2 ? MAX_POST : MAX_FRAME)) {
        buf = Buffer.alloc(0);
        return void socket.destroy();
      }
      const masked = (buf[1] & 0x80) !== 0;
      const end = at + (masked ? 4 : 0) + length;
      if (buf.length < end) return;
      const payload = Buffer.from(buf.subarray(end - length, end));
      if (masked) {
        const mask = buf.subarray(at, at + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      const opcode = buf[0] & 0x0f;
      buf = buf.subarray(end);
      onFrame(opcode, payload);
    }
  });
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
