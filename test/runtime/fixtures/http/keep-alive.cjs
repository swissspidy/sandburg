// Once a response ended, how long its connection stays: by the client's agent (Connection: close, the
// server's Keep-Alive hint, none) and the server's keepAliveTimeout ('timeout' then, or closed). Each
// case prints what happened, and checks when the connection's end came after the response.
const http = require('http');
const lines = [];
/** [ms, latest ms]: when the server's side of the connection ends after the response went. */
const run = (name, agent, listen, [min, max], keepAliveTimeout = 2000) => new Promise((done) => {
  const log = [];
  let sent = 0;
  let end = NaN;
  const s = http.createServer((req, res) => {
    log.push('connection ' + req.headers.connection);
    req.socket.on('close', () => {
      log.push('server socket close');
      if (Number.isNaN(end)) end = performance.now() - sent;
    });
    res.end('ok', () => (sent = performance.now()));
  });
  // The client's hint is its whole seconds, which a Node agent keeps a second less.
  s.keepAliveTimeout = keepAliveTimeout;
  if (listen) s.on('timeout', (sock) => {
    log.push('server timeout');
    end = performance.now() - sent;
    sock.destroy();
  });
  s.listen(0, () => {
    http.get(`http://localhost:${s.address().port}/`, { agent }, (res) => res.resume());
    setTimeout(() => {
      const when = end >= min - 2 && end <= max ? '' : ` | TIMING: ${Math.round(end)} ms after the response (expected ${min} to ${max})`;
      lines.push(`${name}: ${log.join(', ')}${when}`);
      s.close();
      done();
    }, max + 200);
  });
});
void (async () => {
  const part = process.env.PART;
  if (part !== '2') {
    // The hint (4 s), a second less: 3 s, not the server's 4 s (or 5 s with its buffer).
    await run('global agent', undefined, false, [3000, 3900], 4000);
    await run('new Agent()', new http.Agent(), false, [0, 500]);
    await run('agent: false', false, false, [0, 500]);
  }
  if (part !== '1') {
    // No timeout of its own: the server's keepAliveTimeout and its buffer, 3 s.
    await run('keepAlive agent', new http.Agent({ keepAlive: true }), false, [3000, 4200]);
    await run('keepAlive agent, timeout listener', new http.Agent({ keepAlive: true }), true, [3000, 4200]);
    await run('keepAlive agent, timeout 500', new http.Agent({ keepAlive: true, timeout: 500 }), false, [500, 950]);
  }
  console.log(lines.join('\n'));
  process.exit(0);
})();
