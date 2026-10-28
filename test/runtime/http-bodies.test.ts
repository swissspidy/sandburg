/**
 * The http shim against Node 24 (ADR 0067): each program in fixtures/http runs as is under Node, and
 * what it is expected to print here is what Node 24 printed for it (`node test/runtime/fixtures/http/<name>.cjs`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuntimeHarness } from './harness.ts';

const h = new RuntimeHarness();
before(() => h.open());
after(() => h.close());

/** Runs fixtures/http/`main` (with the other programs it starts) in the runtime: the lines it printed. */
async function run(main: string, others: string[] = [], env: Record<string, string> = {}): Promise<string[]> {
  const files = Object.fromEntries([main, ...others].map((name) => [name, readFileSync(new URL(`./fixtures/http/${name}`, import.meta.url), 'utf8')]));
  const out = await h.run(files, `/app/${main}`, [], undefined, { env });
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.equal(out.stderr, '');
  return out.stdout.trimEnd().split('\n');
}

// The same in each topology: the client writes each chunk once the server echoed the one before (a
// body sent whole at its end would never come), and the server sees a client gone mid-body.
const STREAMED = [
  'client /echo: got A, got B, got C, got ., client end',
  'client /mid: client error socket hang up',
  'client /timeout: got late, client end',
  'client /idle: client error socket hang up',
  'server request /echo content-length=- transfer-encoding=chunked, data a, data b, data c, end, req close',
  'server request /mid content-length=- transfer-encoding=chunked, data a, aborted, req error ECONNRESET, req close',
  'server request /idle content-length=- transfer-encoding=chunked, aborted, req error ECONNRESET, req close',
];

for (const topology of ['here', 'child server', 'child client', 'siblings']) {
  test(`http: a request body streams to its server, which sees it end or its client go, and times it out (${topology})`, async () => {
    assert.deepEqual(await run('streamed-body.cjs', [], { TOPOLOGY: topology }), STREAMED);
  });
}

test("http: a request body's framing (chunked, its length, none) and when its server sees each chunk", async () => {
  assert.deepEqual(await run('body-framing.cjs'), [
    'post write+end: request POST content-length=- transfer-encoding=chunked, data a, data b, end complete=true, req close, res close, client response end',
    'post end(data): request POST content-length=2 transfer-encoding=-, data ab, end complete=true, req close, res close, client response end',
    'post end(): request POST content-length=0 transfer-encoding=-, end complete=true, req close, res close, client response end',
    'get end(): request GET content-length=- transfer-encoding=-, end complete=true, req close, res close, client response end',
    'get end(data): request GET content-length=- transfer-encoding=-, end complete=true, req close, res close, client response end',
    'delete end(data): request DELETE content-length=- transfer-encoding=-, end complete=true, req close, res close, client response end',
    'put length: request PUT content-length=2 transfer-encoding=-, data ab, end complete=true, req close, res close, client response end',
    'put length, later: request PUT content-length=2 transfer-encoding=-, data a, >100, data b, end complete=true, req close, res close, client response end',
    'post flushHeaders: request POST content-length=- transfer-encoding=chunked, >100, data a, end complete=true, req close, res close, client response end',
    'post slow: request POST content-length=- transfer-encoding=chunked, data a, >100, data b, >200, data c, end complete=true, req close, res close, client response end',
    'post same tick: request POST content-length=- transfer-encoding=chunked, data a, data b, data c, end complete=true, req close, res close, client response end',
    'post destroyed mid-body: request POST content-length=- transfer-encoding=chunked, data a, >100, aborted, res close, req error ECONNRESET aborted, req close, client error socket hang up',
    'post aborted mid-body: request POST content-length=- transfer-encoding=chunked, data a, >100, aborted, res close, req error ECONNRESET aborted, req close, client error socket hang up',
    'post headers then destroyed: request POST content-length=- transfer-encoding=chunked, >100, aborted, res close, req error ECONNRESET aborted, req close, client error socket hang up',
  ]);
});

test('http: a client writing a body faster than its server reads it waits for it, and all of it arrives (in a process, and to a child)', async () => {
  assert.deepEqual(await run('backpressure.cjs'), [
    '{"written":8388608,"falses":true,"stalled":true,"received":8388608,"same":true}',
  ]);
  assert.deepEqual(await run('backpressure-child.cjs'), [
    '{"written":8388608,"falses":true,"stalled":true,"received":8388608,"same":true}',
  ]);
});

test("http: server.setTimeout, res.setTimeout and req.setTimeout: 'timeout' on the request, response and server, else the connection closes", async () => {
  assert.deepEqual(await run('server-timeouts.cjs', [], { PART: '1' }), [
    'server.setTimeout cb: >50, >150, res timeout socket=true, server timeout cb destroyed=false, >250, >350, >450, >550, >650, >750, >950',
    'server.timeout, no listener: >50, >150, client error socket hang up, aborted, res close, >250, >350, >450, >550, >650, >750, >950',
    'server.setTimeout cb destroys: >50, >150, client error socket hang up, aborted, res close, >250, >350, >450, >550, >650, >750, >950',
    'server timeout answers: >50, >150, res timeout socket=true, res close, client response 200, client end "late", >250, >350, >450, >550, >650, >750, >950',
    'res.setTimeout cb: >50, >150, res timeout socket=true, res cb, res close, client response 200, client end "late", >250, >350, >450, >550, >650, >750, >950',
    'res.setTimeout no cb: >50, >150, client error socket hang up, aborted, res close, >250, >350, >450, >550, >650, >750, >950',
    'req.setTimeout complete GET: >50, >150, client error socket hang up, aborted, res close, >250, >350, >450, >550, >650, >750, >950',
    'req.setTimeout mid-body: >50, >150, req timeout socket=true, req cb, res timeout socket=true, res close, client response 200, client end "t", >250, >350, >450, >550, >650, >750, >950',
    'writes keep it alive: >50, client response 200, >150, >250, >350, >450, >550, client res aborted, aborted, res close, >650, >750, >950',
  ]);
});

test('http: idle time starts over with what is read or written; requestTimeout fails a body that takes too long (408, or clientError)', async () => {
  assert.deepEqual(await run('server-timeouts.cjs', [], { PART: '2' }), [
    'body keeps it alive: data 0, >50, data 1, >150, data 2, >250, data 3, >350, >450, client error socket hang up, aborted, res close, >550, >650, >750, >950',
    'fires again after activity: >50, >150, res timeout socket=true, server timeout, >250, client response 200, >350, >450, res timeout socket=true, server timeout, >550, >650, res close, client end "x", >750, >950',
    'set after the request came: >50, >150, >250, >350, res close, client response 200, client end "ok", >450, >550, >650, >750, >950',
    'setTimeout(0) clears: >50, >150, >250, >350, >450, res close, client response 200, client end "ok", >550, >650, >750, >950',
    'requestTimeout: >50, >150, >250, client response 408, aborted, res close, >350, >450, >550, >650, >750, >950',
    'requestTimeout clientError: >50, >150, >250, clientError ERR_HTTP_REQUEST_TIMEOUT Request timeout, client error socket hang up, aborted, res close, >350, >450, >550, >650, >750, >950',
    'requestTimeout clientError response: >50, >150, >250, client response 408, client end "slow", aborted, res close, >350, >450, >550, >650, >750, >950',
    'requestTimeout, headersTimeout longer: >50, >150, >250, >350, >450, >550, client response 408, aborted, res close, >650, >750, >950',
    'requestTimeout complete: >50, >150, >250, >350, >450, >550, res close, client response 200, client end "ok", >650, >750, >950',
  ]);
});

test("http: once its response ended, a connection stays as long as its client's agent keeps it, or the server's keepAliveTimeout", async () => {
  assert.deepEqual(await run('keep-alive.cjs'), [
    'global agent: connection keep-alive, >250, >750, server socket close, >1500, >2500, >3500',
    'new Agent(): connection close, server socket close, >250, >750, >1500, >2500, >3500',
    'agent: false: connection close, server socket close, >250, >750, >1500, >2500, >3500',
    'keepAlive agent: connection keep-alive, >250, >750, >1500, >2500, server socket close, >3500',
    'keepAlive agent, timeout listener: connection keep-alive, >250, >750, >1500, >2500, server timeout, server socket close, >3500',
    'keepAlive agent, timeout 500: connection keep-alive, >250, server socket close, >750, >1500, >2500, >3500',
  ]);
});

test('http: server timeout options: their defaults, what is refused, and setTimeout', async () => {
  assert.deepEqual(await run('server-options.cjs'), [
    'default: timeout=0 requestTimeout=300000 headersTimeout=60000 keepAliveTimeout=5000 keepAliveTimeoutBuffer=1000 connectionsCheckingInterval=30000',
    'requestTimeout 1000: timeout=0 requestTimeout=1000 headersTimeout=1000 keepAliveTimeout=5000 keepAliveTimeoutBuffer=1000 connectionsCheckingInterval=30000',
    'all: timeout=0 requestTimeout=0 headersTimeout=7000 keepAliveTimeout=100 keepAliveTimeoutBuffer=5 connectionsCheckingInterval=10',
    '{"headersTimeout":2000,"requestTimeout":1000}: RangeError ERR_OUT_OF_RANGE The value of "headersTimeout" is out of range. It must be <= requestTimeout. Received 2000',
    '{"requestTimeout":-1}: RangeError ERR_OUT_OF_RANGE The value of "requestTimeout" is out of range. It must be >= 0 && <= 9007199254740991. Received -1',
    '{"keepAliveTimeout":1.5}: RangeError ERR_OUT_OF_RANGE The value of "keepAliveTimeout" is out of range. It must be an integer. Received 1.5',
    '{"headersTimeout":"5"}: TypeError ERR_INVALID_ARG_TYPE The "headersTimeout" argument must be of type number. Received type string (\'5\')',
    'setTimeout returns the server: true timeout=5 listeners=1',
  ]);
});
