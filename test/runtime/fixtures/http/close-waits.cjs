// server.close(cb) with a connection that outlives a response in flight: the open connection keeps
// the process alive (nothing else does), and cb comes once it closed (the server's keepAliveTimeout and
// its buffer after the response, 6 s), before the socket's own 'close'.
const http = require('http');
const log = [];
let slowDone = NaN;
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
    res.on('end', () => {
      slowDone = performance.now();
      log.push('client got ' + b);
    });
  });
  setTimeout(() => {
    s.getConnections((e, n) => log.push('connections ' + n));
    s.close(() => {
      const after = performance.now() - slowDone;
      log.push('close cb' + (after >= 6000 - 2 && after <= 7500 ? '' : ` TIMING: ${Math.round(after)} ms after the response (expected 6000 to 7500)`));
      setTimeout(() => console.log(log.join('\n')), 10);
    });
  }, 100);
});
