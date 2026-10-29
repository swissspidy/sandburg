// server.close(cb) with a connection that outlives a response in flight: the open connection keeps
// the process alive (nothing else does), and cb comes once it closed (the server's keepAliveTimeout and
// its buffer after the response, 6 s), before the socket's own 'close'.
//
// "After the response" is when the server's response finished: Node arms the connection's keep-alive
// timeout then (resOnFinish), and res.end()'s callback runs right after. Not when the client got the
// response, which comes later (on a loopback, ~2 ms here and more on Windows): from there the 6 s
// read short. The one tolerance is 1 ms, the resolution of the clock timers count on: Node's timers
// take their start from libuv's loop time in whole milliseconds (uv_now()), so a timer may fire up to
// 1 ms before its time has passed by performance.now().
const http = require('http');
const log = [];
let slowSent = NaN;
const s = http.createServer((req, res) => {
  req.socket.on('close', () => log.push('server socket close ' + req.url));
  if (req.url === '/slow') setTimeout(() => res.end('slow done', () => (slowSent = performance.now())), 300);
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
      const after = performance.now() - slowSent;
      log.push('close cb' + (after >= 6000 - 1 && after <= 7500 ? '' : ` TIMING: ${Math.round(after)} ms after the response (expected 6000 to 7500)`));
      setTimeout(() => console.log(log.join('\n')), 10);
    });
  }, 100);
});
