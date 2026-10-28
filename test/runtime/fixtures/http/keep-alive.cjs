// Once a response ended, how long its connection stays: by the client's agent (Connection: close, the
// server's Keep-Alive hint, none) and the server's keepAliveTimeout ('timeout' then, or closed).
const http = require('http');
const lines = [];
const run = (name, agent, listen) => new Promise((done) => {
  const log = [];
  // What happened when: '>' marks, between the times things happen at (0, 500, 1000 and 3000 ms).
  const marks = [250, 750, 1500, 2500, 3500].map((ms) => setTimeout(() => log.push('>' + ms), ms));
  const s = http.createServer((req, res) => {
    log.push('connection ' + req.headers.connection);
    req.socket.on('close', () => log.push('server socket close'));
    res.end('ok');
  });
  s.keepAliveTimeout = 2000;
  if (listen) s.on('timeout', (sock) => { log.push('server timeout'); sock.destroy(); });
  s.listen(0, () => {
    http.get(`http://localhost:${s.address().port}/`, { agent }, (res) => res.resume());
    setTimeout(() => { marks.forEach(clearTimeout); lines.push(`${name}: ${log.join(', ')}`); s.close(); done(); }, 3700);
  });
});
(async () => {
  await run('global agent', undefined, false);
  await run('new Agent()', new http.Agent(), false);
  await run('agent: false', false, false);
  await run('keepAlive agent', new http.Agent({ keepAlive: true }), false);
  await run('keepAlive agent, timeout listener', new http.Agent({ keepAlive: true }), true);
  await run('keepAlive agent, timeout 500', new http.Agent({ keepAlive: true, timeout: 500 }), false);
  console.log(lines.join('\n'));
  process.exit(0);
})();
