// keepAliveTimeout 0, 50 sequential requests through an agent that keeps its sockets with no timeout:
// how many connections the server still has.
const http = require('http');
const s = http.createServer((req, res) => res.end('ok'));
s.keepAliveTimeout = 0;
s.listen(0, async () => {
  const agent = new http.Agent({ keepAlive: true });
  for (let i = 0; i < 50; i++) await new Promise((done) => http.get(`http://localhost:${s.address().port}/`, { agent }, (res) => { res.resume(); res.on('end', done); }));
  setTimeout(() => s.getConnections((e, n) => { console.log(`at most 1 open: ${n <= 1}`); process.exit(0); }), 50);
});
