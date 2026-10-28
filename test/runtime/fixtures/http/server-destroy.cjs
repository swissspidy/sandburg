// The server destroys its request (read or not, with an error or not): when its events come.
const http = require('http');
let log, how;
http.createServer((req, res) => {
  const push = (s) => log.push(s);
  req.on('aborted', () => push('aborted'));
  req.on('error', (e) => push('error ' + e.message));
  req.on('close', () => push('req close'));
  res.on('close', () => push('res close'));
  const act = () => {
    push('pre');
    if (how === 'destroy') req.destroy();
    else if (how === 'destroyErr') req.destroy(new Error('mine'));
    else if (how === 'socket') req.socket.destroy();
    else if (how === 'res') res.destroy();
    push('post');
    process.nextTick(() => push('tick'));
    setImmediate(() => push('immediate'));
  };
  if (req.url === '/read') req.on('end', () => setTimeout(act, 5)).resume();
  else setTimeout(act, 5);
}).listen(3095, async () => {
  const lines = [];
  for (const url of ['/', '/read']) for (how of ['destroy', 'destroyErr', 'socket', 'res']) {
    log = [];
    await new Promise((done) => {
      http.get('http://localhost:3095' + url).on('error', () => {});
      setTimeout(done, 100);
    });
    lines.push(`${url} ${how}: ${log.join(',')}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
});
