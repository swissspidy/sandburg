// A request that waits for its socket (an agent's maxSockets) emits 'finish' only once it went out; a
// client that asks for Connection: close has its connection closed once its response ended.
const http = require('http');
const log = [];
http.createServer((req, res) => {
  log.push('request ' + req.url);
  req.socket.on('close', () => log.push('server socket close ' + req.url));
  if (req.url !== '/held') res.end('ok');
}).listen(3081, () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const held = http.get('http://localhost:3081/held', { agent });
  held.on('error', () => {});
  const next = http.get('http://localhost:3081/next', { agent }, (res) => res.resume());
  next.on('socket', () => log.push('next socket'));
  next.on('finish', () => log.push('next finish'));
  setTimeout(() => {
    log.push('destroy held');
    held.destroy();
  }, 100);
  setTimeout(() => {
    http.get('http://localhost:3081/close', { headers: { connection: 'close' } }, (res) => res.resume());
  }, 300);
  setTimeout(() => {
    console.log(log.join('\n'));
    process.exit(0);
  }, 600);
});
