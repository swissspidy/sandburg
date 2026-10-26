import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { acceptFileChannel } from '../../src/orchestrator/host-socket.ts';
import { MAX_BODY, MAX_FRAME, MAX_POST } from '../../src/file-channel.ts';
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

test("the file channel takes POSTs of esbuild's transforms only, as the route's own bound says", async () => {
  const { server, asked, url } = await channelServer();
  const ws = await open(url, ORIGIN);
  assert.deepEqual(await post(ws, 1, '/__sandburg/esbuild-transform?v=0.25.0', '[{},"x"]'), { id: 1, status: 200, body: 'posted 0.25.0 [{},"x"]' });
  // Any other path, a GET path among them, goes to HTTP; nothing is served.
  for (const path of ['/__sandburg/compile?kind=cjs', '/__sandburg/dev-cache/0123456789abcdef01234567', '/__sandburg/nm/k/t/node_modules/a/index.js', '/__sandburg/esbuild-transform/../compile']) {
    assert.equal((await post(ws, 2, path, 'x')).status, 0, path);
  }
  // A body over what the route reads (the route's bound, here 1 MB): refused before it is served.
  assert.equal((await post(ws, 3, '/__sandburg/esbuild-transform', new Uint8Array((1 << 20) + 1))).status, 0);
  ws.close();
  server.close();
  assert.deepEqual(asked, ['POST /__sandburg/esbuild-transform', 'POST /__sandburg/esbuild-transform']);
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
