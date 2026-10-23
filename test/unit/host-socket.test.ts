import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { acceptFileChannel, MAX_BODY } from '../../src/orchestrator/host-socket.ts';
import type { HostRequest } from '../../src/types.ts';

const ORIGIN = 'http://box.sandburg.localhost:1';

async function channelServer() {
  const asked: string[] = [];
  const serve = async (req: HostRequest) => {
    asked.push(`${req.method} ${req.path}`);
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
