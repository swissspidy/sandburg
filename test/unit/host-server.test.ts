import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { HostServer } from '../../src/orchestrator/host-server.ts';
import type { AdapterDescriptor, HostRequest, HostResponse } from '../../src/types.ts';

function adapter(serve: (req: HostRequest) => Promise<HostResponse | null>): AdapterDescriptor {
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
  host.register('s-test', adapter(async () => ({ status: 200, body: 'ok' })));
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
  host.register('s-test', adapter(async () => {
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
