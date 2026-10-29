// Server timeouts: server.setTimeout/timeout, res.setTimeout, req.setTimeout, 'timeout' events, the
// socket destroyed when nobody listens, requestTimeout. Each case prints what happened, in order, and
// checks when the timed events came against what they wait for: at least the timeout after the
// activity it times (as Node promises), and not much later (a generous bound, for loaded machines).
const http = require('http');
let PORT = Number(process.env.PORT || 3040);
/** A timed event's latest, after the earliest it may come. */
const SLACK = 1000;
let log;
const note = (name) => log.push({ name, t: performance.now() });
const cases = [];
/**
 * checks: [event, after, ms]: `event` comes `ms` (to ms + SLACK) after `after` (names, or name#n for the nth).
 * window: how long the case's events are noted (what comes later is left out, not reported late).
 */
const add = (name, setup, client, checks = [], window = 1200) => cases.push({ name, setup, client, checks, window });
// Its 'timeout' events (listening for them keeps the socket), and its end.
const timeouts = (req, res) => {
  req.on('timeout', (s) => note(`req timeout socket=${s === req.socket}`));
  res.on('timeout', (s) => note(`res timeout socket=${s === req.socket}`));
};
const watch = (req, res) => {
  note('request');
  req.on('aborted', () => note('aborted'));
  res.on('close', () => note('res close'));
};
// `ends`: whether to note its response's end (not for Node's own 408, without a length: see the ADR).
const get = (method = 'GET', body, ends = true) => (port) => {
  const r = http.request(`http://localhost:${port}/`, { method }, (res) => {
    note(`client response ${res.statusCode}`);
    let b = '';
    res.on('data', (d) => (b += d));
    if (ends) res.on('end', () => note(`client end ${JSON.stringify(b)}`));
    res.on('aborted', () => note('client res aborted'));
    res.on('error', () => {});
  });
  r.on('error', (e) => note(`client error ${e.message}`));
  if (body) body(r);
  else r.end();
};
// Nobody answers, and server.setTimeout's callback is there: the socket stays.
add('server.setTimeout cb', (s) => { s.setTimeout(200, (sock) => note(`server timeout cb destroyed=${sock.destroyed}`)); s.on('request', (req, res) => { watch(req, res); timeouts(req, res); }); }, get(), [['res timeout', 'request', 200], ['server timeout cb', 'request', 200]]);
// server.timeout, nobody listens: the socket is destroyed.
add('server.timeout, no listener', (s) => { s.timeout = 200; s.on('request', watch); }, get(), [['client error', 'request', 200]]);
// The callback ends it.
add('server.setTimeout cb destroys', (s) => { s.setTimeout(200, (sock) => sock.destroy()); s.on('request', watch); }, get(), [['client error', 'request', 200]]);
add('server timeout answers', (s) => { s.setTimeout(200); s.on('timeout', () => {}); s.on('request', (req, res) => { watch(req, res); timeouts(req, res); res.on('timeout', () => res.end('late')); }); }, get(), [['res timeout', 'request', 200]]);
add('res.setTimeout cb', (s) => s.on('request', (req, res) => { watch(req, res); timeouts(req, res); res.setTimeout(200, () => { note('res cb'); res.end('late'); }); }), get(), [['res cb', 'request', 200]]);
add('res.setTimeout no cb', (s) => s.on('request', (req, res) => { watch(req, res); res.setTimeout(200); }), get(), [['client error', 'request', 200]]);
add('req.setTimeout complete GET', (s) => s.on('request', (req, res) => { watch(req, res); req.setTimeout(200, () => note('req cb')); }), get(), [['client error', 'request', 200]]);
add('req.setTimeout mid-body', (s) => s.on('request', (req, res) => { watch(req, res); timeouts(req, res); req.setTimeout(200, () => { note('req cb'); res.end('t'); }); }), get('POST', (r) => r.write('a')), [['req cb', 'request', 200]]);
// Each write starts the idle time over: the timeout comes after the last.
add('writes keep it alive', (s) => { s.timeout = 200; s.on('request', (req, res) => { watch(req, res); res.writeHead(200); let n = 0; const i = setInterval(() => { res.write('x'); note(`write ${++n}`); if (n === 4) clearInterval(i); }, 100); }); }, get(), [['client res aborted', 'write 4', 200]]);
// So does each chunk of the body. The chunks come 100 ms apart, 400 ms in all (the timeout 300), each
// written once the server read the one before: its 'data' listener works 100 ms, then the client
// writes the next. No timer of the program spaces them: a loop turn that starts late times the body
// out between chunks only when it is 300 ms late (the idle timeout), where a client's 100 ms interval,
// due beside the idle timer, made it 100 ms. Its client error comes ~700 ms in: its window is that and SLACK.
let bodyRequest;
add('body keeps it alive', (s) => { s.timeout = 300; s.on('request', (req, res) => { watch(req, res); req.on('data', (d) => { note(`data ${d}`); const end = performance.now() + 100; while (performance.now() < end); if (Number(d) < 3) bodyRequest.write(String(Number(d) + 1)); }); req.on('end', () => res.end('ok')); }); }, get('POST', (r) => { bodyRequest = r; r.write('0'); }), [['client error', 'data 3', 400]], 700 + SLACK);
// A 'data' listener that takes long (300 ms, the timeout 200): its idle time counts from its end.
add('slow data listener', (s) => { s.timeout = 200; s.on('request', (req, res) => { watch(req, res); req.on('data', (d) => { note(`data ${d}`); if (String(d) === '1') { const end = performance.now() + 300; while (performance.now() < end); } }); }); }, get('POST', (r) => { r.write('0'); setTimeout(() => r.write('1'), 100); }), [['client error', 'data 1', 500]]);
add('fires again after activity', (s) => { s.setTimeout(200, () => note('server timeout')); s.on('request', (req, res) => { watch(req, res); timeouts(req, res); res.writeHead(200); setTimeout(() => { res.write('x'); note('write'); }, 300); setTimeout(() => res.end(), 700); }); }, get(), [['res timeout', 'request', 200], ['res timeout#2', 'write', 200]]);
add('set after the request came', (s) => s.on('request', (req, res) => { watch(req, res); s.setTimeout(100, () => note('server timeout')); setTimeout(() => res.end('ok'), 400); }), get());
add('setTimeout(0) clears', (s) => s.on('request', (req, res) => { watch(req, res); res.setTimeout(200); setTimeout(() => res.setTimeout(0), 100); setTimeout(() => res.end('ok'), 500); }), get());
add('requestTimeout', (s) => { s.requestTimeout = 300; s.headersTimeout = 300; s.on('request', watch); }, get('POST', (r) => r.write('a'), false), [['client response 408', 'request', 300]]);
add('requestTimeout clientError', (s) => { s.requestTimeout = 300; s.headersTimeout = 300; s.on('clientError', (e, sock) => { note(`clientError ${e.code} ${e.message}`); sock.destroy(); }); s.on('request', watch); }, get('POST', (r) => r.write('a')), [['clientError', 'request', 300]]);
add('requestTimeout clientError response', (s) => { s.requestTimeout = 300; s.headersTimeout = 300; s.on('clientError', (e, sock) => sock.end('HTTP/1.1 408 Too Slow\r\nX-Why: ' + e.code + '\r\n\r\nslow')); s.on('request', watch); }, get('POST', (r) => r.write('a')), [['client response 408', 'request', 300]]);
// As measured: a request with its headers expires after the longer of requestTimeout and headersTimeout.
add('requestTimeout, headersTimeout longer', (s) => { s.requestTimeout = 300; s.headersTimeout = 600; s.on('request', watch); }, get('POST', (r) => r.write('a'), false), [['client response 408', 'request', 600]]);
add('requestTimeout complete', (s) => { s.requestTimeout = 300; s.headersTimeout = 300; s.on('request', (req, res) => { watch(req, res); setTimeout(() => res.end('ok'), 600); }); }, get());

/** Each check that failed: its event, and when it came after what it waits for. */
function late(entries, checks) {
  const find = (key) => {
    const [name, n] = key.split('#');
    return entries.filter((e) => e.name.startsWith(name))[Number(n ?? 1) - 1];
  };
  const bad = [];
  for (const [event, after, ms] of checks) {
    const e = find(event);
    const a = find(after);
    const gap = e && a ? e.t - a.t : NaN;
    // A timer may fire up to 1 ms early by performance.now(): the resolution of the clock timers
    // count on (Node's take their start from libuv's loop time, in whole milliseconds). Unrounded:
    // rounding would let it be 1.5 ms early.
    if (!(gap >= ms - 1 && gap <= ms + SLACK)) bad.push(`${event} ${Math.round(gap)} ms after ${after} (expected ${ms} to ${ms + SLACK})`);
  }
  return bad;
}

async function main() {
  const lines = [];
  // PART 1 or 2: the first or second half of the cases.
  const half = Math.ceil(cases.length / 2);
  for (const c of process.env.PART === '2' ? cases.slice(half) : process.env.PART === '1' ? cases.slice(0, half) : cases) {
    log = [];
    const port = PORT++;
    const s = http.createServer({ connectionsCheckingInterval: 20 });
    c.setup(s);
    await new Promise((r) => s.listen(port, r));
    c.client(port);
    await new Promise((r) => setTimeout(r, c.window));
    const mine = log;
    log = [];
    const bad = late(mine, c.checks);
    lines.push(`${c.name}: ${mine.map((e) => e.name).join(', ')}${bad.length ? ` | TIMING: ${bad.join('; ')}` : ''}`);
    s.closeAllConnections();
    s.close();
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(lines.join('\n'));
  process.exit(0);
}
void main();
