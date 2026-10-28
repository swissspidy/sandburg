// The server of destroy-order.cjs, in a child process (CHILD=1).
const http = require('http');
http.createServer((req, res) => {
  req.resume();
  if (req.url === '/silent') return;
  if (req.url === '/hold') { res.writeHead(200); res.write('a'); return; }
  req.on('end', () => res.end('ok'));
}).listen(Number(process.env.PORT || 3030), () => process.send('ready'));
