import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { request } from 'node:http';
import { EgressProxy, parseConnectTarget } from '../../src/orchestrator/egress-proxy.ts';
import { MAX_ENTRIES, MAX_URL, newEgressStats, originMatcher, record } from '../../src/orchestrator/egress.ts';

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

test('CONNECT targets are parsed strictly: a host or bracketed IPv6 literal, and a port 1-65535 without leading zeros', () => {
  assert.deepEqual(parseConnectTarget('example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(parseConnectTarget('Example.COM:8443'), { host: 'example.com', port: 8443 });
  assert.deepEqual(parseConnectTarget('127.0.0.1:1'), { host: '127.0.0.1', port: 1 });
  assert.deepEqual(parseConnectTarget('[::1]:443'), { host: '::1', port: 443 });
  assert.deepEqual(parseConnectTarget('[2001:db8::1]:65535'), { host: '2001:db8::1', port: 65535 });
  for (const target of ['', '[', '[::1', '[::1]', '[::1]:', '[nope]:443', '[fe80::1%25eth0]:443', 'host', 'host:', ':443', 'host:0', 'host:0443', 'host:65536', 'host:99999', 'host:+443', 'host:44 3', 'host:443:443', 'a..b:443', '-a:443', 'a b:443', 'a/b:443', 'user@host:443', `${'a'.repeat(64)}:443`, `${'a.'.repeat(200)}a:443`]) {
    assert.equal(parseConnectTarget(target), null, target);
  }
});

/** Sends a raw request to the proxy and resolves with its status line (or '' when the proxy closed without one). */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(text));
    let buf = '';
    sock.on('data', (d) => (buf += d.toString('latin1')));
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
    sock.on('error', reject);
  });
}

test('malformed CONNECT targets get a 400 and are recorded, and the proxy keeps serving', async () => {
  const echo = createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  const port = (echo.address() as { port: number }).port;
  const saved = process.env.HTTPS_PROXY;
  delete process.env.HTTPS_PROXY;
  const stats = newEgressStats();
  // A wildcard entry: the matcher parses what it is given (`https://[` threw there, and the process exited).
  const proxy = new EgressProxy(originMatcher([`https://127.0.0.1:${port}`, 'https://*.sandburg.test']), stats);
  await proxy.listen();
  try {
    const malformed = ['[', '[::1', 'host:', 'host:0443', 'host:99999', `${'a'.repeat(5000)}:443`];
    for (const target of malformed) assert.match((await connectVia(proxy.port, target)).status, / 400 /, target);
    // An empty target.
    assert.match(await rawRequest(proxy.port, 'CONNECT  HTTP/1.1\r\nHost: x\r\n\r\n'), / 400 /);
    assert.deepEqual(stats.blocked.map((b) => b.reason), [...malformed, ''].map(() => 'malformed CONNECT target'));
    assert.ok(stats.blocked.every((b) => b.url.length <= MAX_URL));
    // An IPv6 literal that is well formed but not allowlisted.
    assert.match((await connectVia(proxy.port, '[::1]:443')).status, / 403 /);
    assert.equal(stats.blocked.at(-1)!.url, 'https://[::1]');
    // Still serving.
    const allowed = await connectVia(proxy.port, `127.0.0.1:${port}`);
    assert.match(allowed.status, / 200 /);
    assert.equal(allowed.echo, 'echo:ping');
  } finally {
    if (saved) process.env.HTTPS_PROXY = saved;
    await proxy.close();
    echo.close();
  }
});

test('the origin matcher matches nothing for an origin that is not a URL', () => {
  const allow = originMatcher(['https://esm.sh', 'https://*.sandburg.test']);
  for (const origin of ['https://[', 'https://[::1', 'http://a b', 'https://']) assert.equal(allow(origin), false, origin);
  assert.equal(allow('https://a.sandburg.test'), true);
});

test('a run\'s blocked and failed requests are kept up to MAX_ENTRIES, with URLs up to MAX_URL', async () => {
  const stats = newEgressStats();
  const proxy = new EgressProxy(originMatcher([]), stats);
  await proxy.listen();
  try {
    // A page can make blocked requests without end, each with a long URL.
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example`;
    for (let i = 0; i < MAX_ENTRIES + 50; i++) assert.match((await connectVia(proxy.port, `${host}:${1000 + i}`)).status, / 403 /);
    assert.equal(stats.requests, MAX_ENTRIES + 50);
    assert.equal(stats.blocked.length, MAX_ENTRIES);
  } finally {
    await proxy.close();
  }
  const failed: { url: string; method: string; reason: string }[] = [];
  for (let i = 0; i < MAX_ENTRIES + 1; i++) record(failed, { url: `https://x.test/${'p'.repeat(1 << 20)}`, method: 'GET', reason: 'r'.repeat(1 << 20) });
  assert.equal(failed.length, MAX_ENTRIES);
  assert.ok(failed.every((f) => f.url.length === MAX_URL && f.reason.length === MAX_URL));
});

test("a recorded URL does not keep the request's whole URL in memory", () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  const before = process.memoryUsage().heapUsed;
  const failed: { url: string; method: string; reason: string }[] = [];
  // Each URL is 1 MB, made anew: a cut that is a view of it would keep all 200 MB.
  for (let i = 0; i < MAX_ENTRIES; i++) record(failed, { url: `https://x.test/${i}/${'p'.repeat(1 << 20)}`, method: 'GET', reason: `${i}${'r'.repeat(1 << 20)}` });
  gc();
  const retained = process.memoryUsage().heapUsed - before;
  assert.ok(retained < 32 * 2 ** 20, `${Math.round(retained / 2 ** 20)} MB kept for ${MAX_ENTRIES} entries`);
  assert.ok(failed.every((f) => f.url.length === MAX_URL && f.reason.length === MAX_URL));
});
