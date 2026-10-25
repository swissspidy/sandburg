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
  let connections = 0;
  const echo = createServer((s) => (connections++, s.on('data', (d) => s.write(`echo:${d}`))));
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

    // Plain HTTP proxying is refused outright, to an allowlisted host too, and to any method.
    for (const [method, url] of [['GET', 'http://example.com/'], ['GET', `http://127.0.0.1:${port}/`], ['POST', `http://127.0.0.1:${port}/`]]) {
      const status = await new Promise<number>((resolve) => {
        request({ host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: new URL(url).host } }, (res) => resolve(res.statusCode!)).end();
      });
      assert.equal(status, 403, `${method} ${url}`);
    }
    // An allowlisted host on another port, loopback by other names, and a sandbox's own host.
    for (const target of [`127.0.0.1:${port + 1}`, `localhost:${port}`, `ip6-localhost:${port}`, `one.sandburg.localhost:${port}`]) {
      assert.match((await connectVia(proxy.port, target)).status, / 403 /, target);
    }
    assert.equal(stats.tunneled, 1);
    assert.equal(connections, 1, 'only the allowlisted tunnel reached the server');
  } finally {
    if (saved) process.env.HTTPS_PROXY = saved;
    await proxy.close();
    echo.close();
  }
});

test('a proxy without tunnels refuses allowlisted origins too, and records why', async () => {
  const stats = newEgressStats();
  const proxy = new EgressProxy(originMatcher(['https://allowed.sandburg.test']), stats, { noTunnels: true });
  await proxy.listen();
  try {
    assert.match((await connectVia(proxy.port, 'allowed.sandburg.test:443')).status, / 403 /);
    assert.match((await connectVia(proxy.port, 'example.com:443')).status, / 403 /);
    assert.deepEqual(
      stats.blocked.map((b) => [b.url, b.reason]),
      [
        ['https://allowed.sandburg.test', 'HTTPS the gateway did not intercept (a popup or frame before its interception)'],
        ['https://example.com', 'origin not allowlisted'],
      ],
    );
    assert.equal(stats.tunneled, 0);
  } finally {
    await proxy.close();
  }
});
