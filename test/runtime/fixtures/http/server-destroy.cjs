// The server destroys its request (read or not, with an error or not): when its events come.
const http = require('http');
let log, how;
// Over once the immediate the action queued ran and the request closed, and its response too where it
// does (not a request read to its end, then destroyed: closed already, it emits nothing).
let over = () => {};
const terminal = (url) => ['immediate', 'req close', ...(url === '/read' && how.startsWith('destroy') ? [] : ['res close'])];
http.createServer((req, res) => {
  const push = (s) => {
    log.push(s);
    over();
  };
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
    const late = await new Promise((done) => {
      const bound = setTimeout(() => done(true), 3000);
      over = () => {
        if (!terminal(url).every((e) => log.includes(e))) return;
        clearTimeout(bound);
        done(false);
      };
      http.get('http://localhost:3095' + url).on('error', () => {});
    });
    lines.push(`${url} ${how}: ${log.join(',')}${late ? ' | TIMING: not over in 3000 ms' : ''}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
});
