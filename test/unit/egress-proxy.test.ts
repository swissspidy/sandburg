import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { request } from 'node:http';
import { EgressProxy } from '../../src/orchestrator/egress-proxy.ts';
import { newEgressStats, originMatcher } from '../../src/orchestrator/egress.ts';

function connectVia(proxyPort: number, target: string): Promise<{ status: string; echo?: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    let pinged = false;
    sock.on('data', (d) => {
      buf += d.toString();
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const status = buf.split('\r\n')[0];
      if (!status.includes(' 200 ')) return (sock.destroy(), resolve({ status }));
      if (buf.length > end + 4) return (sock.destroy(), resolve({ status, echo: buf.slice(end + 4) }));
      if (!pinged) {
        pinged = true;
        sock.write('ping');
      }
    });
    sock.on('error', reject);
  });
}

test('the egress proxy tunnels only to allowlisted origins and records the rest', async () => {
  const echo = createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  const port = (echo.address() as { port: number }).port;
  const saved = process.env.HTTPS_PROXY;
  delete process.env.HTTPS_PROXY; // connect directly in this test
  const stats = newEgressStats();
  const proxy = new EgressProxy(originMatcher([`https://127.0.0.1:${port}`]), stats);
  await proxy.listen();
  try {
    const allowed = await connectVia(proxy.port, `127.0.0.1:${port}`);
    assert.match(allowed.status, / 200 /);
    assert.equal(allowed.echo, 'echo:ping');

    const blocked = await connectVia(proxy.port, 'example.com:443');
    assert.match(blocked.status, / 403 /);
    assert.deepEqual(stats.blocked.map((b) => [b.method, b.url]), [['CONNECT', 'https://example.com']]);
    assert.equal(stats.tunneled, 1);

    // Plain HTTP proxying is refused outright.
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: proxy.port, path: 'http://example.com/', headers: { host: 'example.com' } }, (res) => resolve(res.statusCode!)).end();
    });
    assert.equal(status, 403);
  } finally {
    if (saved) process.env.HTTPS_PROXY = saved;
    await proxy.close();
    echo.close();
  }
});
