// What a server does with its connections: 'connection' for each (counted: the runtime emits it with
// its request, Node as the connection comes), close() closing the idle ones,
// closeIdleConnections() and closeAllConnections(), and getConnections().
const http = require('http');
const lines = [];
const run = (name, act, paths = ['/ok', '/held']) => new Promise((done) => {
  const log = [];
  // Which connections closed, by the time of each mark (Node closes several in no set order).
  const closed = [];
  let connections = 0;
  const marks = [100, 300, 1500].map((ms) => setTimeout(() => log.push(`>${ms} connections=${connections} closed=${closed.sort((a, b) => a.localeCompare(b)).join('+') || 'none'}`), ms));
  const s = http.createServer((req, res) => {
    log.push('request ' + req.url);
    req.socket.on('close', () => closed.push(req.url));
    if (req.url === '/ok') res.end('ok');
  });
  s.on('connection', (socket) => connections += typeof socket.on === 'function' ? 1 : 0);
  s.listen(0, () => {
    const get = (path) => http.get(`http://localhost:${s.address().port}${path}`, (res) => res.resume()).on('error', (e) => log.push(`client error ${path} ${e.message}`));
    for (const path of paths) get(path);
    setTimeout(() => {
      s.getConnections((e, n) => log.push(`connections ${n}`));
      act(s, log);
    }, 200);
    setTimeout(() => {
      marks.forEach(clearTimeout);
      lines.push(`${name}: ${log.join(', ')}`);
      s.closeAllConnections();
      s.close();
      done();
    }, 2000);
  });
});
void (async () => {
  await run('close()', (s, log) => s.close(() => log.push('closed')));
  await run('closeIdleConnections()', (s) => s.closeIdleConnections());
  await run('closeAllConnections()', (s) => s.closeAllConnections());
  // Its only connection idle: close() closes it, and 'close' comes.
  await run('close(), all idle', (s, log) => s.close(() => log.push('closed')), ['/ok']);
  console.log(lines.join('\n'));
  process.exit(0);
})();
