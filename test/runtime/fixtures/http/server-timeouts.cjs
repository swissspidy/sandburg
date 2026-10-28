// Server timeouts: server.setTimeout/timeout, res.setTimeout, req.setTimeout, 'timeout' events, the socket destroyed when nobody listens, requestTimeout.
const http = require('http');
let PORT = Number(process.env.PORT || 3040);
// The time unit (ms per 100): wide enough apart for a loaded machine.
const U = 2;
let log;
// What happened when: '>' marks, half-way between the 100 ms the cases do things on.
const at = () => '';
const cases = [];
const add = (name, setup, client) => cases.push({ name, setup, client });
// Its 'timeout' events (listening for them keeps the socket), and its end.
const timeouts = (req, res) => {
  req.on('timeout', (s) => log.push(`req timeout socket=${s === req.socket}`));
  res.on('timeout', (s) => log.push(`res timeout socket=${s === req.socket}`));
};
const watch = (req, res) => {
  req.on('aborted', () => log.push(`aborted`));
  res.on('close', () => log.push(`res close`));
};
// `ends`: whether to note its response's end (not for Node's own 408, without a length: see the ADR).
const get = (method = 'GET', body, ends = true) => (port) => {
  const r = http.request(`http://localhost:${port}/`, { method }, (res) => {
    log.push(`client response ${res.statusCode}`);
    let b = '';
    res.on('data', (d) => (b += d));
    if (ends) res.on('end', () => log.push(`client end ${JSON.stringify(b)}`));
    res.on('aborted', () => log.push(`client res aborted`));
    res.on('error', () => {});
  });
  r.on('error', (e) => log.push(`client error ${e.message}`));
  if (body) body(r);
  else r.end();
};
// Nobody answers, and server.setTimeout's callback is there: the socket stays.
add('server.setTimeout cb', (s) => { s.setTimeout(200 * U, (sock) => log.push(`server timeout cb destroyed=${sock.destroyed}`)); s.on('request', (req, res) => { watch(req, res); timeouts(req, res); }); }, get());
// server.timeout, nobody listens: the socket is destroyed.
add('server.timeout, no listener', (s) => { s.timeout = 200 * U; s.on('request', watch); }, get());
// The callback ends it.
add('server.setTimeout cb destroys', (s) => { s.setTimeout(200 * U, (sock) => sock.destroy()); s.on('request', watch); }, get());
add('server timeout answers', (s) => { s.setTimeout(200 * U); s.on('timeout', () => {}); s.on('request', (req, res) => { watch(req, res); timeouts(req, res); res.on('timeout', () => res.end('late')); }); }, get());
add('res.setTimeout cb', (s) => s.on('request', (req, res) => { watch(req, res); timeouts(req, res); res.setTimeout(200 * U, () => { log.push(`res cb`); res.end('late'); }); }), get());
add('res.setTimeout no cb', (s) => s.on('request', (req, res) => { watch(req, res); res.setTimeout(200 * U); }), get());
add('req.setTimeout complete GET', (s) => s.on('request', (req, res) => { watch(req, res); req.setTimeout(200 * U, () => log.push(`req cb`)); }), get());
add('req.setTimeout mid-body', (s) => s.on('request', (req, res) => { watch(req, res); timeouts(req, res); req.setTimeout(200 * U, () => { log.push(`req cb`); res.end('t'); }); }), get('POST', (r) => r.write('a')));
add('writes keep it alive', (s) => { s.timeout = 200 * U; s.on('request', (req, res) => { watch(req, res); res.writeHead(200); let n = 0; const i = setInterval(() => { res.write('x'); if (++n === 4) clearInterval(i); }, 100 * U); }); }, get());
add('body keeps it alive', (s) => { s.timeout = 200 * U; s.on('request', (req, res) => { watch(req, res); req.on('data', (d) => log.push(`data ${d}`)); req.on('end', () => res.end('ok')); }); }, get('POST', (r) => { let n = 0; r.write('0'); const i = setInterval(() => { r.write(String(++n)); if (n === 3) clearInterval(i); }, 100 * U); }));
add('fires again after activity', (s) => { s.setTimeout(200 * U, () => log.push(`server timeout`)); s.on('request', (req, res) => { watch(req, res); timeouts(req, res); res.writeHead(200); setTimeout(() => res.write('x'), 300 * U); setTimeout(() => res.end(), 700 * U); }); }, get());
add('set after the request came', (s) => s.on('request', (req, res) => { watch(req, res); s.setTimeout(100 * U, () => log.push(`server timeout`)); setTimeout(() => res.end('ok'), 400 * U); }), get());
add('setTimeout(0) clears', (s) => s.on('request', (req, res) => { watch(req, res); res.setTimeout(200 * U); setTimeout(() => res.setTimeout(0), 100 * U); setTimeout(() => res.end('ok'), 500 * U); }), get());
add('requestTimeout', (s) => { s.requestTimeout = 300 * U; s.headersTimeout = 300 * U; s.on('request', watch); }, get('POST', (r) => r.write('a'), false));
add('requestTimeout clientError', (s) => { s.requestTimeout = 300 * U; s.headersTimeout = 300 * U; s.on('clientError', (e, sock) => { log.push(`clientError ${e.code} ${e.message}`); sock.destroy(); }); s.on('request', watch); }, get('POST', (r) => r.write('a')));
add('requestTimeout clientError response', (s) => { s.requestTimeout = 300 * U; s.headersTimeout = 300 * U; s.on('clientError', (e, sock) => sock.end('HTTP/1.1 408 Too Slow\r\nX-Why: ' + e.code + '\r\n\r\nslow')); s.on('request', watch); }, get('POST', (r) => r.write('a')));
add('requestTimeout complete', (s) => { s.requestTimeout = 300 * U; s.headersTimeout = 300 * U; s.on('request', (req, res) => { watch(req, res); setTimeout(() => res.end('ok'), 600 * U); }); }, get());

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
    const marks = [50, 150, 250, 350, 450, 550, 650, 750, 950].map((ms) => setTimeout(() => log.push('>' + ms), ms * U));
    c.client(port);
    await new Promise((r) => setTimeout(r, 1000 * U));
    marks.forEach(clearTimeout);
    const mine = log;
    log = [];
    lines.push(`${c.name}: ${mine.join(', ')}`);
    s.closeAllConnections();
    s.close();
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(lines.join('\n'));
  process.exit(0);
}
main();
