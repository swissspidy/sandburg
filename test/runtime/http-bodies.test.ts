/**
 * The http shim against Node 24 (ADR 0069): each program in fixtures/http runs as is under Node, and
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
// body sent whole at its end would never come), Expect: 100-continue and early hints, and the server
// sees a client gone mid-body.
const STREAMED = [
  'client /echo: got A, got B, got C, got ., client end',
  'client /continue: information 100 {}, information 103 {"link":"</a.css>; rel=preload"}, got ok, client end',
  'client /mid: got A',
  'client /timeout: got late, client end',
  'client /idle: client error socket hang up',
  'server request /echo content-length=- transfer-encoding=chunked, data a, data b, data c, end, req close',
  'server request /continue content-length=- transfer-encoding=chunked, data after continue, req close',
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
    'server.setTimeout cb: request, res timeout socket=true, server timeout cb destroyed=false',
    'server.timeout, no listener: request, client error socket hang up, aborted, res close',
    'server.setTimeout cb destroys: request, client error socket hang up, aborted, res close',
    'server timeout answers: request, res timeout socket=true, res close, client response 200, client end "late"',
    'res.setTimeout cb: request, res timeout socket=true, res cb, res close, client response 200, client end "late"',
    'res.setTimeout no cb: request, client error socket hang up, aborted, res close',
    'req.setTimeout complete GET: request, client error socket hang up, aborted, res close',
    'req.setTimeout mid-body: request, req timeout socket=true, req cb, res timeout socket=true, res close, client response 200, client end "t"',
    'writes keep it alive: request, write 1, client response 200, write 2, write 3, write 4, client res aborted, aborted, res close',
    'body keeps it alive: request, data 0, data 1, data 2, data 3, client error socket hang up, aborted, res close',
  ]);
});

test('http: idle time starts over with what is read or written; requestTimeout fails a body that takes too long (408, or clientError)', async () => {
  assert.deepEqual(await run('server-timeouts.cjs', [], { PART: '2' }), [
    'slow data listener: request, data 0, data 1, client error socket hang up, aborted, res close',
    'fires again after activity: request, res timeout socket=true, server timeout, write, client response 200, res timeout socket=true, server timeout, res close, client end "x"',
    'set after the request came: request, res close, client response 200, client end "ok"',
    'setTimeout(0) clears: request, res close, client response 200, client end "ok"',
    'requestTimeout: request, client response 408, aborted, res close',
    'requestTimeout clientError: request, clientError ERR_HTTP_REQUEST_TIMEOUT Request timeout, client error socket hang up, aborted, res close',
    'requestTimeout clientError response: request, client response 408, client end "slow", aborted, res close',
    'requestTimeout, headersTimeout longer: request, client response 408, aborted, res close',
    'requestTimeout complete: request, res close, client response 200, client end "ok"',
  ]);
});

test("http: once its response ended, a connection stays as long as its client's agent keeps it", async () => {
  assert.deepEqual(await run('keep-alive.cjs', [], { PART: '1' }), [
    'global agent: connection keep-alive, server socket close',
    'new Agent(): connection close, server socket close',
    'agent: false: connection close, server socket close',
  ]);
});

test("http: with a keepAlive agent, a connection stays for the server's keepAliveTimeout ('timeout' then, or closed), or the agent's own timeout", async () => {
  assert.deepEqual(await run('keep-alive.cjs', [], { PART: '2' }), [
    'keepAlive agent: connection keep-alive, server socket close',
    'keepAlive agent, timeout listener: connection keep-alive, server timeout, server socket close',
    'keepAlive agent, timeout 500: connection keep-alive, server socket close',
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

test("http: a server's connections: 'connection', getConnections(), close() closing the idle ones, closeIdleConnections() and closeAllConnections()", async () => {
  assert.deepEqual(await run('server-close.cjs'), [
    'close(): request /ok, request /held, before: connections=2 closed=none, connections 2, socket close, after: connections=2 closed=/ok',
    'closeIdleConnections(): request /ok, request /held, before: connections=2 closed=none, connections 2, socket close, after: connections=2 closed=/ok',
    'closeAllConnections(): request /ok, request /held, before: connections=2 closed=none, connections 2, client error /held socket hang up, socket close, socket close, after: connections=2 closed=/held+/ok',
    'close(), all idle: request /ok, before: connections=1 closed=none, connections 1, closed, socket close, after: connections=1 closed=/ok',
    'close(), then closeAllConnections(): request /ok, request /held, before: connections=2 closed=none, connections 2, closed, client error /held socket hang up, immediate, socket close, socket close, after: connections=2 closed=/held+/ok',
  ]);
});

test("http: Expect: 100-continue ('continue', 'checkContinue'), other expectations (417, 'checkExpectation'), and early hints", async () => {
  assert.deepEqual(await run('expect.cjs'), [
    '100-continue: server request, client continue, client information 100 Continue {}, server body "body", client response 200 "ok"',
    'checkContinue, continued: server checkContinue, client continue, client information 100 Continue {}, server body "body", client response 200 "ok"',
    'checkContinue, refused: server checkContinue, client response 417 "no"',
    'other expectation: client response 417 ""',
    'checkExpectation: server checkExpectation something, client response 200 "checked"',
    'early hints: server body "y", client information 103 Early Hints {"link":"</a.css>; rel=preload"}, client information 102 Processing {}, client response 200 "ok"',
  ]);
});

test("http: an unref'd server does not keep the process alive; one ref'd again does, until it closes", async () => {
  assert.deepEqual(await run('server-unref.cjs'), [
    'closing the ref\'d one',
    'exit',
  ]);
});

test("http: a sibling runtime's forged response (start, informational, body, end) for a request it does not answer reaches no one", async () => {
  assert.deepEqual(await run('forged-response.cjs'), [
    'client: 200 x-forged=- "real" information=none',
  ]);
});

test("http: with keepAliveTimeout 0 (and no server.timeout), a page request's connection closes once its response ended", async () => {
  // A page's requests have no client here to close their connection: kept, they would add up (and keep
  // the server's connections counted) while it runs.
  const out = await h.run({ 'main.js': `
        const http = require('http');
        const s = http.createServer((req, res) => {
          if (req.url !== '/count') return res.end('ok');
          s.getConnections((e, n) => res.end(String(n)));
        });
        s.keepAliveTimeout = 0;
        s.listen(3000);` }, '/app/main.js', [{ url: '/a' }, { url: '/b' }, { url: '/count' }]);
  assert.equal(out.fatal, null, out.fatal ?? out.stderr);
  assert.deepEqual(out.responses.map((r) => r.body), ['ok', 'ok', '1']);
});

test('http: with keepAliveTimeout 0, an agent that keeps its sockets with no timeout leaves at most one connection open (as Node, which reuses it)', async () => {
  assert.deepEqual(await run('keep-alive-none.cjs'), ['at most 1 open: true']);
});

test('http: server.close(cb) with a connection that outlives a response: it keeps the process alive, and cb comes once it closed', async () => {
  assert.deepEqual(await run('close-waits.cjs'), [
    'connections 2',
    'server socket close /idle',
    'client got slow done',
    'close cb',
    'server socket close /slow',
  ]);
});
