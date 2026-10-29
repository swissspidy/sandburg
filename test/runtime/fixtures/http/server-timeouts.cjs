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
/** checks: [event, after, ms]: `event` comes `ms` (to ms + SLACK) after `after` (names, or name#n for the nth). */
const add = (name, setup, client, checks = []) => cases.push({ name, setup, client, checks });
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
// So does each chunk of the body.
add('body keeps it alive', (s) => { s.timeout = 200; s.on('request', (req, res) => { watch(req, res); req.on('data', (d) => note(`data ${d}`)); req.on('end', () => res.end('ok')); }); }, get('POST', (r) => { let n = 0; r.write('0'); const i = setInterval(() => { r.write(String(++n)); if (n === 3) clearInterval(i); }, 100); }), [['client error', 'data 3', 200]]);
// A 'data' listener that takes long (300 ms, the timeout 200): its idle time counts from its end.
add('slow data listener', (s) => { s.timeout = 200; s.on('request', (req, res) => { watch(req, res); req.on('data', (d) => { note(`data ${d}`); if (String(d) === '1') { const end = Date.now() + 300; while (Date.now() < end); } }); }); }, get('POST', (r) => { r.write('0'); setTimeout(() => r.write('1'), 100); }), [['client error', 'data 1', 500]]);
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
    const gap = e && a ? Math.round(e.t - a.t) : NaN;
    // A timer may fire a little early by the clock it is measured against (1 ms granularity).
    if (!(gap >= ms - 2 && gap <= ms + SLACK)) bad.push(`${event} ${gap} ms after ${after} (expected ${ms} to ${ms + SLACK})`);
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
    await new Promise((r) => setTimeout(r, 1200));
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
