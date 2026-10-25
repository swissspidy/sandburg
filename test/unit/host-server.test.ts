/**
 * The host server's boundaries (ADR 0001, ADR 0030), tried from outside: a request names its
 * sandbox by its Host, requests from another site are refused, and the file channel's upgrade is
 * routed to the sandbox it names and accepted only from that sandbox's own pages.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { HostServer, SANDBOX_DOMAIN } from '../../src/orchestrator/host-server.ts';
import { FILE_CHANNEL_PATH } from '../../src/orchestrator/host-socket.ts';
import type { AdapterDescriptor, HostRequest, HostResponse } from '../../src/types.ts';

const served: string[] = [];

function adapter(name: string): AdapterDescriptor {
  return {
    name,
    version: '0',
    browserEntry: '',
    assets: {},
    egress: [],
    crossOriginIsolation: false,
    probe: () => ({ verdict: 'supported' }),
    serve: async (req: HostRequest) => {
      served.push(`${name} ${req.method} ${req.path}`);
      return { status: 200, body: `${name} answers` };
    },
  };
}

let host: HostServer;
let one: string;
let two: string;

before(async () => {
  host = new HostServer();
  await host.listen();
  one = host.register('one', adapter('one'));
  two = host.register('two', adapter('two'));
});
after(() => host.close());

/** A request to the host server as a browser would send it, with the headers given. */
function get(path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: host.port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const hostOf = (origin: string) => new URL(origin).host;

test('a request is served only for a registered sandbox on the host server port', async () => {
  served.length = 0;
  assert.equal((await get('/__sandburg/x', { host: hostOf(one), 'sec-fetch-site': 'same-origin' })).body, 'one answers');
  // The same name on another port, an unknown sandbox, no Host at all, and the bare domain.
  for (const h of [`one.${SANDBOX_DOMAIN}:${host.port + 1}`, `three.${SANDBOX_DOMAIN}:${host.port}`, `127.0.0.1:${host.port}`, `${SANDBOX_DOMAIN}:${host.port}`, `localhost:${host.port}`]) {
    const res = await get('/__sandburg/x', { host: h });
    assert.equal(res.status, 403, h);
  }
  assert.deepEqual(served, ['one GET /__sandburg/x']);
});

test('a sandbox that ended is not served any more', async () => {
  const gone = host.register('gone', adapter('gone'));
  assert.equal((await get('/__sandburg/x', { host: hostOf(gone) })).status, 200);
  host.unregister('gone');
  assert.equal((await get('/__sandburg/x', { host: hostOf(gone) })).status, 403);
});

test('requests from another site are refused before the adapter sees them', async () => {
  served.length = 0;
  for (const site of ['same-site', 'cross-site']) {
    for (const path of ['/', '/__sandburg/host.js', '/__sandburg/dev-cache/0123456789abcdef01234567', '/__sandburg/compile', '/__sw__.js']) {
      for (const method of ['GET', 'POST']) {
        const res = await get(path, { host: hostOf(one), 'sec-fetch-site': site, origin: two }, method);
        assert.deepEqual(res, { status: 403, body: 'requests from another site are refused' }, `${method} ${path} (${site})`);
      }
    }
  }
  assert.deepEqual(served, []);
  // The sandbox's own requests, and navigations the user starts (none), are served.
  assert.equal((await get('/', { host: hostOf(one), 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await get('/', { host: hostOf(one), 'sec-fetch-site': 'none' })).status, 200);
});

test('sandbox ids are DNS labels: no dots, so a Host cannot name one sandbox inside another', () => {
  for (const id of ['a.b', 'one.two', '', 'A', 'a_b', 'a'.repeat(64), 'a:1']) assert.throws(() => host.register(id, adapter('x')), /invalid sandbox id/, id);
});

/** Asks for the file channel; resolves with the HTTP status of the answer (101 when it is accepted). */
function upgrade(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const all: Record<string, string> = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers };
    const socket = connect(host.port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
    });
    let head = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      head += String(d);
      const line = /^HTTP\/1\.1 (\d+)/.exec(head);
      if (line) {
        socket.destroy();
        resolve(Number(line[1]));
      }
    });
    socket.on('error', reject);
  });
}

test("the file channel opens only for a sandbox's own pages", async () => {
  assert.equal(await upgrade(FILE_CHANNEL_PATH, { host: hostOf(one), origin: one }), 101);
  // Another sandbox's page, a page of another site, and a client that sends no Origin.
  assert.equal(await upgrade(FILE_CHANNEL_PATH, { host: hostOf(one), origin: two }), 403);
  assert.equal(await upgrade(FILE_CHANNEL_PATH, { host: hostOf(one), origin: 'https://example.com' }), 403);
  assert.equal(await upgrade(FILE_CHANNEL_PATH, { host: hostOf(one) }), 403);
  // The Origin of the sandbox named in the Host, on another port.
  assert.equal(await upgrade(FILE_CHANNEL_PATH, { host: hostOf(one), origin: `http://one.${SANDBOX_DOMAIN}:${host.port + 1}` }), 403);
  // An unknown sandbox, and other paths: no channel.
  assert.equal(await upgrade(FILE_CHANNEL_PATH, { host: `three.${SANDBOX_DOMAIN}:${host.port}`, origin: `http://three.${SANDBOX_DOMAIN}:${host.port}` }), 404);
  assert.equal(await upgrade('/__sandburg/other', { host: hostOf(one), origin: one }), 404);
});

function stub(serve: (req: HostRequest) => Promise<HostResponse | null>): AdapterDescriptor {
  return { name: 'stub', version: '0', browserEntry: '', assets: {}, egress: [], crossOriginIsolation: false, probe: () => ({ verdict: 'supported' }), serve } as unknown as AdapterDescriptor;
}

/** Sends `text` to the server and resolves with what came back once the server closed (or after `ms`). */
function raw(port: number, text: string, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(text));
    let buf = '';
    const timer = setTimeout(() => (sock.destroy(), resolve(buf)), ms);
    sock.on('data', (d) => (buf += d.toString('latin1')));
    sock.on('close', () => (clearTimeout(timer), resolve(buf)));
    sock.on('error', reject);
  });
}

test('a request target that is not a URL path fails that connection only: the host server keeps serving', async () => {
  const host = new HostServer();
  await host.listen();
  host.register('s-test', stub(async () => ({ status: 200, body: 'ok' })));
  const hostHeader = `s-test.sandburg.localhost:${host.port}`;
  try {
    // A WebSocket upgrade to `//[` (`new URL` throws for it): the upgrade handler threw, and the process exited.
    const upgrade = await raw(host.port, `GET //[ HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    assert.match(upgrade, /^HTTP\/1\.1 404 /);
    const plain = await raw(host.port, `GET //[ HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    assert.match(plain, /^HTTP\/1\.1 400 /);
    const ok = await raw(host.port, `GET /__sandburg/anything HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    assert.match(ok, /^HTTP\/1\.1 200 /);
  } finally {
    await host.close();
  }
});

test('a request the host fails to answer gets a 500 without the error: its details are logged on the host', async () => {
  const logged: [unknown, string][] = [];
  const host = new HostServer({ onError: (err, path) => logged.push([err, path]) });
  await host.listen();
  const secret = new Error(`ENOENT: no such file, open '${process.cwd()}/.sandburg/installs/x/node_modules/a.js'`);
  host.register('s-test', stub(async () => {
    throw secret;
  }));
  try {
    const answer = await raw(host.port, `GET /__sandburg/nm/x?token=1 HTTP/1.1\r\nHost: s-test.sandburg.localhost:${host.port}\r\nConnection: close\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 500 /);
    assert.ok(answer.includes('internal error (logged by the host)'), answer);
    for (const leak of [process.cwd(), 'ENOENT', 'at ', '.sandburg']) assert.ok(!answer.includes(leak), leak);
    assert.deepEqual(logged, [[secret, '/__sandburg/nm/x']]);
  } finally {
    await host.close();
  }
});

test('stashed arguments are served once, to their own sandbox, by GET only', async () => {
  const path = host.stash('one', JSON.stringify([{ index: { 'node_modules/a/index.js': 1 } }]));
  // Another sandbox's origin (it knows the path), another site, a POST: not found.
  assert.equal((await get(path, { host: hostOf(two) })).status, 404);
  assert.equal((await get(path, { host: hostOf(one), 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await get(path, { host: hostOf(one) }, 'POST')).status, 404);
  // A guessed id.
  assert.equal((await get(`${path.slice(0, -4)}AAAA`, { host: hostOf(one) })).status, 404);
  const first = await get(path, { host: hostOf(one), 'sec-fetch-site': 'same-origin' });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), [{ index: { 'node_modules/a/index.js': 1 } }]);
  assert.equal((await get(path, { host: hostOf(one) })).status, 404);
  // Nothing reached the adapter.
  assert.ok(!served.some((s) => s.includes('/__sandburg/args/')));
});

test('a sandbox unregistered drops its stashed arguments', async () => {
  const three = host.register('three', adapter('three'));
  const path = host.stash('three', '[1]');
  host.unregister('three');
  host.register('three', adapter('three'));
  assert.equal((await get(path, { host: hostOf(three) })).status, 404);
  host.unregister('three');
});
