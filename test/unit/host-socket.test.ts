import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { acceptFileChannel } from '../../src/orchestrator/host-socket.ts';
import { FRAGMENT_COST, MAX_BODY, MAX_FRAME, MAX_POST } from '../../src/file-channel.ts';
import type { HostRequest } from '../../src/types.ts';

const ORIGIN = 'http://box.sandburg.localhost:1';

async function channelServer() {
  const asked: string[] = [];
  const serve = async (req: HostRequest) => {
    asked.push(`${req.method} ${req.path}`);
    if (req.method === 'POST') return { status: 200, body: `posted ${req.query.get('v')} ${(await req.body(1 << 20)).toString('utf8')}` };
    if (req.path.endsWith('/missing.js')) return null;
    if (req.path.endsWith('/big.wasm')) return { status: 200, body: new Uint8Array(MAX_BODY + 1) };
    return { status: 200, body: `file ${decodeURIComponent(req.path.split('/').pop()!)}` };
  };
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket) => acceptFileChannel(req, socket, ORIGIN, serve));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, asked, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/__sandburg/files` };
}

function open(url: string, origin: string): Promise<WebSocket> {
  // Node's WebSocket (undici) takes headers; a browser sends its page's Origin.
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('refused'));
  });
}

function ask(ws: WebSocket, id: number, path: string): Promise<{ id: number; status: number; body: string }> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      const view = new DataView(e.data as ArrayBuffer);
      if (view.getUint32(0, true) !== id) return;
      ws.removeEventListener('message', onMessage);
      resolve({ id, status: view.getUint32(4, true), body: new TextDecoder().decode(new Uint8Array(e.data as ArrayBuffer, 8)) });
    };
    ws.addEventListener('message', onMessage);
    ws.send(`${id} ${path}`);
  });
}

test('the file channel answers GETs of installed files, by id', async () => {
  const { server, asked, url } = await channelServer();
  const ws = await open(url, ORIGIN);
  const [a, b] = await Promise.all([ask(ws, 1, '/__sandburg/nm/k/t/node_modules/a/index.js'), ask(ws, 2, '/__sandburg/nm/k/f/node_modules/a/my file.json')]);
  assert.deepEqual(a, { id: 1, status: 200, body: 'file index.js' });
  // Paths are parsed as URLs, as the browser parses an XMLHttpRequest's.
  assert.deepEqual(b, { id: 2, status: 200, body: 'file my file.json' });
  assert.equal((await ask(ws, 3, '/__sandburg/nm/k/t/node_modules/a/missing.js')).status, 404);
  ws.close();
  server.close();
  assert.deepEqual(asked.slice(0, 2).sort(), ['GET /__sandburg/nm/k/f/node_modules/a/my%20file.json', 'GET /__sandburg/nm/k/t/node_modules/a/index.js']);
});

test('the file channel sends large bodies and other paths to HTTP (status 0)', async () => {
  const { server, asked, url } = await channelServer();
  const ws = await open(url, ORIGIN);
  assert.deepEqual(await ask(ws, 7, '/__sandburg/nm/k/f/node_modules/a/big.wasm'), { id: 7, status: 0, body: '' });
  assert.deepEqual(await ask(ws, 8, '/__sandburg/preload/abc/def'), { id: 8, status: 0, body: '' });
  ws.close();
  server.close();
  assert.deepEqual(asked, ['GET /__sandburg/nm/k/f/node_modules/a/big.wasm']);
});

test('the file channel refuses pages of other origins', async () => {
  const { server, url } = await channelServer();
  await assert.rejects(open(url, 'http://other.sandburg.localhost:1'));
  server.close();
});

test('the file channel closes on a frame larger than a request can be', async () => {
  const { server, asked, url } = await channelServer();
  const ws = await open(url, ORIGIN);
  const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
  ws.send(`1 /__sandburg/nm/k/t/${'a'.repeat(MAX_FRAME)}`);
  await closed;
  server.close();
  assert.deepEqual(asked, []);
});

/** A POST frame: the id and the path's length (u32 little-endian), the path, the body. */
function post(ws: WebSocket, id: number, path: string, body: Uint8Array | string): Promise<{ id: number; status: number; body: string }> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      const view = new DataView(e.data as ArrayBuffer);
      if (view.getUint32(0, true) !== id) return;
      ws.removeEventListener('message', onMessage);
      resolve({ id, status: view.getUint32(4, true), body: new TextDecoder().decode(new Uint8Array(e.data as ArrayBuffer, 8)) });
    };
    ws.addEventListener('message', onMessage);
    const p = new TextEncoder().encode(path);
    const b = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const frame = new Uint8Array(8 + p.length + b.length);
    new DataView(frame.buffer).setUint32(0, id, true);
    new DataView(frame.buffer).setUint32(4, p.length, true);
    frame.set(p, 8);
    frame.set(b, 8 + p.length);
    ws.send(frame);
  });
}

test("the file channel takes POSTs of esbuild's transforms and the runtime's compiles only, as the route's own bound says", async () => {
  const { server, asked, url } = await channelServer();
  const ws = await open(url, ORIGIN);
  assert.deepEqual(await post(ws, 1, '/__sandburg/esbuild-transform?v=0.25.0', '[{},"x"]'), { id: 1, status: 200, body: 'posted 0.25.0 [{},"x"]' });
  assert.deepEqual(await post(ws, 4, '/__sandburg/compile?v=cjs', 'x'), { id: 4, status: 200, body: 'posted cjs x' });
  // Any other path, a GET path among them, goes to HTTP; nothing is served.
  for (const path of ['/__sandburg/compile/x', '/__sandburg/dev-cache/0123456789abcdef01234567', '/__sandburg/nm/k/t/node_modules/a/index.js', '/__sandburg/esbuild-transform/../dev-cache']) {
    assert.equal((await post(ws, 2, path, 'x')).status, 0, path);
  }
  // A body over what the route reads (the route's bound, here 1 MB): refused before it is served.
  assert.equal((await post(ws, 3, '/__sandburg/esbuild-transform', new Uint8Array((1 << 20) + 1))).status, 0);
  ws.close();
  server.close();
  assert.deepEqual(asked, ['POST /__sandburg/esbuild-transform', 'POST /__sandburg/compile', 'POST /__sandburg/esbuild-transform']);
});

test("a POST's capability token comes in its query over the channel, and reaches the route as the header it is over HTTP", async () => {
  const seen: { token?: string; query: string }[] = [];
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket) =>
    acceptFileChannel(req, socket, ORIGIN, async (r) => {
      seen.push({ token: r.headers?.['x-sandburg-token'], query: r.query.toString() });
      return { status: 200, body: 'ok' };
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const ws = await open(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/__sandburg/files`, ORIGIN);
  await post(ws, 1, '/__sandburg/compile?kind=cjs&cache=abc&token=secret', 'x');
  await post(ws, 2, '/__sandburg/compile?kind=cjs', 'x');
  ws.close();
  server.close();
  assert.deepEqual(seen, [
    { token: 'secret', query: 'kind=cjs&cache=abc' },
    { token: undefined, query: 'kind=cjs' },
  ]);
});

test('the file channel closes on a POST larger than a transform can be, or a malformed one', async () => {
  for (const frame of [new Uint8Array(MAX_POST + 1), new Uint8Array(4), (() => { const f = new Uint8Array(16); new DataView(f.buffer).setUint32(4, 1000, true); return f; })()]) {
    const { server, asked, url } = await channelServer();
    const ws = await open(url, ORIGIN);
    const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
    ws.send(frame);
    await closed;
    server.close();
    assert.deepEqual(asked, []);
  }
});

/**
 * A raw client of the channel, for what Node's WebSocket never sends: fragmented messages (Chromium
 * splits larger ones into a first frame without FIN and continuation frames).
 */
async function rawChannel(url: string): Promise<{ send(fin: boolean, opcode: number, payload: Uint8Array): void; messages: Buffer[]; closed: Promise<void>; isClosed(): boolean; end(): void }> {
  const { connect } = await import('node:net');
  const { port } = new URL(url);
  const socket = connect(Number(port), '127.0.0.1');
  const messages: Buffer[] = [];
  let buf = Buffer.alloc(0);
  let upgraded = false;
  const ready = new Promise<void>((resolve, reject) => {
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.subarray(0, end).toString().startsWith('HTTP/1.1 101')) return reject(new Error('refused'));
        upgraded = true;
        buf = buf.subarray(end + 4);
        resolve();
      }
      // The host's frames: unmasked, binary, with 16- or 64-bit lengths.
      while (buf.length >= 2) {
        let length = buf[1] & 0x7f;
        let at = 2;
        if (length === 126) [length, at] = [buf.readUInt16BE(2), 4];
        else if (length === 127) [length, at] = [Number(buf.readBigUInt64BE(2)), 10];
        if (buf.length < at + length) break;
        messages.push(Buffer.from(buf.subarray(at, at + length)));
        buf = buf.subarray(at + length);
      }
    });
  });
  socket.on('error', () => {}); // the host closes the channel on some of what these tests send
  let isClosed = false;
  const closed = new Promise<void>((r) => socket.on('close', () => ((isClosed = true), r())));
  socket.write(`GET /__sandburg/files HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await ready;
  return {
    send(fin, opcode, payload) {
      const mask = Buffer.from([1, 2, 3, 4]);
      const n = payload.length;
      const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
      const body = Buffer.from(payload).map((b, i) => b ^ mask[i & 3]);
      if (!socket.destroyed) socket.write(Buffer.concat([head, mask, body]));
    },
    messages,
    closed,
    isClosed: () => isClosed,
    end: () => socket.destroy(),
  };
}

/** A POST message's bytes: the id and the path's length (u32 little-endian), the path, the body. */
function postMessage(id: number, path: string, body: Uint8Array): Uint8Array {
  const p = new TextEncoder().encode(path);
  const out = new Uint8Array(8 + p.length + body.length);
  new DataView(out.buffer).setUint32(0, id, true);
  new DataView(out.buffer).setUint32(4, p.length, true);
  out.set(p, 8);
  out.set(body, 8 + p.length);
  return out;
}

test('the file channel puts a fragmented message together, with a ping between its fragments', async () => {
  const { server, asked, url } = await channelServer();
  const raw = await rawChannel(url);
  const body = new TextEncoder().encode('x'.repeat(100_000));
  const message = postMessage(5, '/__sandburg/esbuild-transform?v=1', body);
  // As Chromium sends a larger message: a binary frame without FIN, continuations, the last with FIN.
  raw.send(false, 0x2, message.subarray(0, 32_768));
  raw.send(false, 0x0, message.subarray(32_768, 65_536));
  raw.send(true, 0x9, new Uint8Array([7]));
  raw.send(true, 0x0, message.subarray(65_536));
  // And a fragmented text message (a GET), after it.
  const get = new TextEncoder().encode('6 /__sandburg/nm/k/t/node_modules/a/index.js');
  raw.send(false, 0x1, get.subarray(0, 10));
  raw.send(true, 0x0, get.subarray(10));
  for (let i = 0; i < 100 && raw.messages.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  raw.end();
  server.close();
  const answers = raw.messages.filter((m) => m.length >= 8).map((m) => ({ id: m.readUInt32LE(0), status: m.readUInt32LE(4), body: m.subarray(8).toString() }));
  assert.deepEqual(answers.find((a) => a.id === 5), { id: 5, status: 200, body: `posted 1 ${'x'.repeat(100_000)}` });
  assert.deepEqual(answers.find((a) => a.id === 6), { id: 6, status: 200, body: 'file index.js' });
  assert.deepEqual(asked.sort(), ['GET /__sandburg/nm/k/t/node_modules/a/index.js', 'POST /__sandburg/esbuild-transform']);
});

test('the file channel closes on fragments larger together than a message may be, or out of order', { timeout: 20_000 }, async () => {
  const cases: [boolean, number, Uint8Array][][] = [
    // Fragments each under the bound, together over it (each also counts FRAGMENT_COST).
    [[false, 0x2, new Uint8Array(MAX_POST - 2 * FRAGMENT_COST)], [true, 0x0, new Uint8Array(FRAGMENT_COST)]],
    [[false, 0x1, new Uint8Array(MAX_FRAME - 2 * FRAGMENT_COST)], [true, 0x0, new Uint8Array(FRAGMENT_COST)]],
    // A continuation with no message, a new message inside one, a fragmented control frame.
    [[true, 0x0, new Uint8Array(8)]],
    [[false, 0x2, new Uint8Array(8)], [true, 0x2, new Uint8Array(8)]],
    [[false, 0x9, new Uint8Array(1)]],
  ];
  for (const frames of cases) {
    const { server, asked, url } = await channelServer();
    const raw = await rawChannel(url);
    for (const [fin, opcode, payload] of frames) raw.send(fin, opcode, payload);
    await raw.closed;
    server.close();
    assert.deepEqual(asked, []);
  }
});

test('the file channel bounds a message in fragments as in bytes: a flood of empty or one-byte fragments closes it', { timeout: 20_000 }, async () => {
  for (const size of [0, 1]) {
    const { server, asked, url } = await channelServer();
    const raw = await rawChannel(url);
    raw.send(false, 0x2, new Uint8Array(size));
    // Far fewer bytes than MAX_POST, far more fragments than it allows (MAX_POST / FRAGMENT_COST).
    for (let i = 0; i < 10_000 && !raw.isClosed(); i++) raw.send(false, 0x0, new Uint8Array(size));
    await raw.closed;
    server.close();
    assert.deepEqual(asked, []);
  }
});

test("a message within the bound in as many fragments as Chromium sends (~33 for 4 MB) is put together", { timeout: 20_000 }, async () => {
  const { server, asked, url } = await channelServer();
  const raw = await rawChannel(url);
  const message = postMessage(9, '/__sandburg/esbuild-transform?v=2', new Uint8Array((4 << 20) - 64));
  const piece = 131_072;
  for (let at = 0; at < message.length; at += piece) raw.send(at + piece >= message.length, at ? 0x0 : 0x2, message.subarray(at, at + piece));
  for (let i = 0; i < 200 && !raw.messages.length; i++) await new Promise((r) => setTimeout(r, 10));
  raw.end();
  server.close();
  assert.equal(raw.messages[0]?.readUInt32LE(0), 9);
  assert.deepEqual(asked, ['POST /__sandburg/esbuild-transform']);
});

/** A channel on an in-memory socket: what the host writes is kept, `push` delivers bytes as a TCP read would. */
async function memoryChannel(serve: (req: HostRequest) => Promise<{ status: number; body: string } | null>) {
  const { Duplex } = await import('node:stream');
  const written: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk: Buffer, _e, done) { written.push(chunk); done(); } });
  const req = { headers: { origin: ORIGIN, 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', upgrade: 'websocket' } } as unknown as import('node:http').IncomingMessage;
  assert.ok(acceptFileChannel(req, socket, ORIGIN, serve));
  return { socket, written };
}

/** A masked client frame (the mask is zeros: the payload as it is). */
function clientFrame(fin: boolean, opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, Buffer.alloc(4), payload]);
}

test('a large frame that comes in small chunks is put together once, not copied for each chunk', { timeout: 20_000 }, async () => {
  let served = 0;
  const { socket } = await memoryChannel(async () => ((served++), { status: 200, body: 'ok' }));
  const bytes = clientFrame(true, 0x2, postMessage(1, '/__sandburg/esbuild-transform', new Uint8Array(4_100_000)));
  const t0 = performance.now();
  // TCP's segment size: ~2,950 reads. Copying what came at each read was ~1.3 s of the host's thread.
  for (let at = 0; at < bytes.length; at += 1460) socket.push(bytes.subarray(at, at + 1460));
  for (let i = 0; i < 200 && !served; i++) await new Promise((r) => setTimeout(r, 5));
  const ms = performance.now() - t0;
  socket.destroy();
  assert.equal(served, 1);
  assert.ok(ms < 400, `${ms.toFixed(0)} ms`);
});

test('nothing after a close frame is served: not a message it left unfinished, nor a later request', { timeout: 20_000 }, async () => {
  const asked: string[] = [];
  const { socket, written } = await memoryChannel(async (req) => (asked.push(`${req.method} ${req.path}`), { status: 200, body: 'ok' }));
  const post = postMessage(1, '/__sandburg/esbuild-transform', new Uint8Array(10));
  // A fragment, a close frame, the fragment's continuation, then a GET.
  socket.push(Buffer.concat([clientFrame(false, 0x2, post.subarray(0, 8)), clientFrame(true, 0x8, new Uint8Array(0)), clientFrame(true, 0x0, post.subarray(8)), clientFrame(true, 0x1, new TextEncoder().encode('2 /__sandburg/nm/k/t/node_modules/a/index.js'))]));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(asked, []);
  // The host's answer to the close: a close frame (after the 101), and its side ended.
  assert.equal(written.at(-1)?.[0], 0x88);
  assert.ok(socket.writableEnded);
  socket.destroy();
});

test('a client that does not read its answers is not answered without bound: the host stops reading until they drain', { timeout: 20_000 }, async () => {
  const { Duplex } = await import('node:stream');
  const { MAX_IN_FLIGHT, MAX_UNSENT } = await import('../../src/orchestrator/host-socket.ts');
  // A socket whose writes are not taken until `drain()`: a client that does not read.
  const held: (() => void)[] = [];
  let reading = false;
  const socket = new Duplex({ read() {}, write(_c, _e, done) { if (reading) done(); else held.push(done); } });
  const req = { headers: { origin: ORIGIN, 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', upgrade: 'websocket' } } as unknown as import('node:http').IncomingMessage;
  let served = 0;
  acceptFileChannel(req, socket, ORIGIN, async () => ((served++), { status: 200, body: 'x'.repeat(512 << 10) }));
  const gets = Buffer.concat(Array.from({ length: 1500 }, (_, i) => clientFrame(true, 0x1, new TextEncoder().encode(`${i + 1} /__sandburg/nm/k/t/node_modules/a/f${i}.js`))));
  socket.push(gets);
  await new Promise((r) => setTimeout(r, 200));
  // Requests are taken while fewer than MAX_IN_FLIGHT are in progress and at most MAX_UNSENT bytes
  // wait to be sent: what waits is bounded by those, and nothing more is read.
  const answer = 512 << 10;
  assert.ok(served > 0 && served <= MAX_IN_FLIGHT + MAX_UNSENT / answer + 1, `served ${served}`);
  const unsent = socket.writableLength;
  assert.ok(unsent <= MAX_UNSENT + (MAX_IN_FLIGHT + 1) * (answer + 16), `${unsent} bytes unsent`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(socket.writableLength, unsent);
  // Once the client reads, the host reads on.
  reading = true;
  for (const done of held.splice(0)) done();
  for (let i = 0; i < 400 && served < 1500; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(served, 1500);
  socket.destroy();
});
