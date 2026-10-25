/**
 * Request bodies to the host: each route reads at most its limit, refused with a 413 as soon as the
 * declared length or the bytes received exceed it, and only after the request is authorized.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BODY_MAX, HostServer } from '../../src/orchestrator/host-server.ts';
import type { AdapterDescriptor } from '../../src/types.ts';

let root: string;
let node: typeof import('../../src/adapters/node/index.ts');
let host: HostServer;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandburg-bodies-'));
  process.env.SANDBURG_INSTALL_DIR = join(root, 'installs');
  node = await import('../../src/adapters/node/index.ts');
  host = new HostServer();
  await host.listen();
  host.register('s-a', node.node);
});
after(async () => {
  await host.close();
  await rm(root, { recursive: true, force: true });
});

interface Sent {
  status: number;
  /** Body bytes the client got to write before the answer (or the connection's end). */
  written: number;
}

/**
 * POSTs to the host as sandbox `s-a`: `declared` as its Content-Length (or chunked without one), then
 * body bytes in 64 KB chunks, up to `send` bytes, until the host answers or closes the connection.
 */
function post(path: string, { declared, send, headers = {} }: { declared?: number; send: number; headers?: Record<string, string> }): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const sock = connect(host.port, '127.0.0.1');
    const head = [`POST ${path} HTTP/1.1`, `Host: s-a.sandburg.localhost:${host.port}`, declared === undefined ? 'Transfer-Encoding: chunked' : `Content-Length: ${declared}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
    let answer = '';
    let written = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sock.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0);
      resolve({ status, written });
    };
    sock.on('data', (d) => {
      answer += d.toString('latin1');
      if (answer.includes('\r\n\r\n')) finish();
    });
    sock.on('close', finish);
    sock.on('error', () => finish());
    sock.on('connect', async () => {
      sock.write(head);
      const chunk = Buffer.alloc(64 << 10, 0x61);
      while (!done && written < send) {
        const n = Math.min(chunk.length, send - written);
        const piece = declared === undefined ? Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), chunk.subarray(0, n), Buffer.from('\r\n')]) : chunk.subarray(0, n);
        written += n;
        if (!sock.write(piece)) await new Promise<void>((r) => (sock.once('drain', r), sock.once('close', r)));
      }
      if (!done && declared === undefined) sock.write('0\r\n\r\n');
    });
    sock.setTimeout(30_000, () => reject(new Error(`no answer from ${path}`)));
  });
}

const MB = 1 << 20;

test('an oversized body to each route is refused with a 413, without the host reading it all', async () => {
  const key = 'e'.repeat(24);
  const token = node.issueCacheWrite(key, ['node_modules/.vite'], Promise.resolve('s-a'));
  await new Promise((r) => setImmediate(r));
  const routes: [string, number, Record<string, string>][] = [
    ['/__sandburg/compile?kind=cjs&path=/a.js', node.SOURCE_BODY_MAX, {}],
    ['/__sandburg/tla-scan', node.SOURCE_BODY_MAX, {}],
    [`/__sandburg/dev-cache/${key}`, node.DEV_CACHE_MAX, { 'x-sandburg-token': token }],
  ];
  for (const [path, max, headers] of routes) {
    // A declared length over the limit: refused before a byte of the body is read.
    const declared = await post(path, { declared: max + 1, send: 64 << 10, headers });
    assert.equal(declared.status, 413, path);
    // Chunked, with no length: refused once the bytes received exceed the limit. The client is
    // stopped within the limit plus what the sockets buffer, far from the 1 GB it would send.
    const streamed = await post(path, { send: max + 1024 * MB, headers });
    assert.equal(streamed.status, 413, path);
    assert.ok(streamed.written < max + 64 * MB, `${path}: ${streamed.written}`);
  }
  // The token was not spent on the refused bodies: an authorized write within the limit lands.
  const cache = { 'node_modules/.vite/deps/_metadata.json': '{}' };
  const body = JSON.stringify(cache);
  const ok = await new Promise<number>((resolve, reject) => {
    const sock = connect(host.port, '127.0.0.1', () => sock.write(`POST /__sandburg/dev-cache/${key} HTTP/1.1\r\nHost: s-a.sandburg.localhost:${host.port}\r\nx-sandburg-token: ${token}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
    let answer = '';
    sock.on('data', (d) => (answer += d));
    sock.on('close', () => resolve(Number(answer.slice(9, 12))));
    sock.on('error', reject);
  });
  assert.equal(ok, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dev-cache', `${key}.json`), 'utf8')), cache);
});

test('a write the host refuses is answered before its body is read', async () => {
  // No token: a 403, while the client has sent 64 KB of a body it declared as 200 MB.
  const refused = await post(`/__sandburg/dev-cache/${'f'.repeat(24)}`, { declared: 200 * MB, send: 64 << 10 });
  assert.equal(refused.status, 403);
});

test('a route reads at most BODY_MAX unless it allows more', async () => {
  const seen: number[] = [];
  const stub = { name: 'stub', version: '0', browserEntry: '', assets: {}, egress: [], probe: () => ({ verdict: 'supported' }), serve: async (req: { body(max?: number): Promise<Buffer> }) => (seen.push((await req.body()).length), { status: 200, body: 'ok' }) } as unknown as AdapterDescriptor;
  host.register('s-a', stub);
  try {
    assert.equal((await post('/__sandburg/x', { declared: BODY_MAX, send: BODY_MAX })).status, 200);
    assert.equal((await post('/__sandburg/x', { send: BODY_MAX + MB })).status, 413);
    assert.deepEqual(seen, [BODY_MAX]);
  } finally {
    host.register('s-a', node.node);
  }
});
