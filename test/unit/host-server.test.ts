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
    assert.match(plain, /^HTTP\/1\.1 [45]\d\d /);
    const ok = await raw(host.port, `GET /__sandburg/anything HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    assert.match(ok, /^HTTP\/1\.1 200 /);
  } finally {
    await host.close();
  }
});
