// Which side hears first when the server ends a connection: res.destroy(), req.socket.destroy(), at once and later.
const http = require('http');
const log = [];
let how;
let over = () => {};
http.createServer((req, res) => {
  req.on('aborted', () => log.push('server aborted'));
  req.on('close', () => {
    log.push('server req close');
    over();
  });
  res.on('close', () => log.push('server res close'));
  const act = () => { log.push('act'); if (how.startsWith('res')) res.destroy(); else req.socket.destroy(); };
  if (how.endsWith('later')) setTimeout(act, 20); else act();
}).listen(3097, async () => {
  const lines = [];
  for (how of ['res now', 'res later', 'socket now', 'socket later']) {
    log.length = 0;
    // Over once both ends closed (or a TIMING failure if that takes too long).
    const late = await new Promise((done) => {
      const bound = setTimeout(() => done(true), 3000);
      over = () => {
        if (!log.includes('client close') || !log.includes('server req close')) return;
        clearTimeout(bound);
        done(false);
      };
      http.get('http://localhost:3097/').on('error', (e) => log.push('client error ' + e.message)).on('close', () => {
        log.push('client close');
        over();
      });
    });
    lines.push(how + ': ' + log.join(',') + (late ? ' | TIMING: not over in 3000 ms' : ''));
  }
  console.log(lines.join('\n'));
  process.exit(0);
});
