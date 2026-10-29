// What a server does with its connections: 'connection' for each (counted: the runtime emits it with
// its request, Node as the connection comes), close() closing the idle ones,
// closeIdleConnections() and closeAllConnections(), and getConnections().
const http = require('http');
const lines = [];
/** A connection's close at most this long after the action (a kept-alive one closes after 5 s). */
const SOON = 1000;
const run = (name, act, paths = ['/ok', '/held']) => new Promise((done) => {
  const log = [];
  // Which connections closed (Node closes several in no set order: the log has each close, these which).
  const closed = [];
  let connections = 0;
  let acted = NaN;
  const state = (when) => `${when}: connections=${connections} closed=${closed.sort((a, b) => a.localeCompare(b)).join('+') || 'none'}`;
  const s = http.createServer((req, res) => {
    log.push('request ' + req.url);
    req.socket.on('close', () => {
      closed.push(req.url);
      const after = performance.now() - acted;
      log.push('socket close' + (after >= 0 && after <= SOON ? '' : ` TIMING: ${Math.round(after)} ms after the action (expected 0 to ${SOON})`));
    });
    if (req.url === '/ok') res.end('ok');
  });
  s.on('connection', (socket) => connections += typeof socket.on === 'function' ? 1 : 0);
  s.listen(0, () => {
    // Once each request came, and the response to /ok ended (its connection idle): the action.
    let waiting = paths.length + (paths.includes('/ok') ? 1 : 0);
    const ready = () => {
      if (--waiting) return;
      setTimeout(() => {
        log.push(state('before'));
        s.getConnections((e, n) => log.push(`connections ${n}`));
        acted = performance.now();
        act(s, log);
        setTimeout(() => {
          log.push(state('after'));
          lines.push(`${name}: ${log.join(', ')}`);
          s.closeAllConnections();
          s.close();
          done();
        }, 1500);
      }, 50);
    };
    s.on('request', ready);
    const get = (path) => http.get(`http://localhost:${s.address().port}${path}`, (res) => {
      res.resume();
      if (path === '/ok') res.on('end', ready);
    }).on('error', (e) => log.push(`client error ${path} ${e.message}`));
    for (const path of paths) get(path);
  });
});
void (async () => {
  await run('close()', (s, log) => s.close(() => log.push('closed')));
  await run('closeIdleConnections()', (s) => s.closeIdleConnections());
  await run('closeAllConnections()', (s) => s.closeAllConnections());
  // Its only connection idle: close() closes it, and 'close' comes.
  await run('close(), all idle', (s, log) => s.close(() => log.push('closed')), ['/ok']);
  // Its last connection closed: 'close' comes on a tick (before an immediate queued with it).
  await run('close(), then closeAllConnections()', (s, log) => {
    s.close(() => log.push('closed'));
    s.closeAllConnections();
    setImmediate(() => log.push('immediate'));
  });
  console.log(lines.join('\n'));
  process.exit(0);
})();
