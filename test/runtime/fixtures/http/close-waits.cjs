// server.close(cb) with a connection that outlives a response in flight: the open connection keeps
// the process alive, and cb comes once it closed (its keep-alive time after the response), before the
// socket's own 'close'.
const http = require('http');
const log = [];
// Unref'd: only the open connection keeps the process alive.
const marks = [50, 200, 400, 3000, 6000, 6600].map((ms) => setTimeout(() => log.push('>' + ms), ms).unref());
const s = http.createServer((req, res) => {
  req.socket.on('close', () => log.push('server socket close ' + req.url));
  if (req.url === '/slow') setTimeout(() => res.end('slow done'), 300);
  else res.end('ok');
});
s.listen(3085, () => {
  http.get('http://localhost:3085/idle', (res) => res.resume());
  const agent = new http.Agent({ keepAlive: true });
  http.get('http://localhost:3085/slow', { agent }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => log.push('client got ' + b));
  });
  setTimeout(() => {
    s.getConnections((e, n) => log.push('connections ' + n));
    s.close(() => {
      log.push('close cb');
      setTimeout(() => {
        marks.forEach(clearTimeout);
        console.log(log.join('\n'));
      }, 10);
    });
  }, 100);
});
