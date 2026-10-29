// As backpressure.cjs, with the server in a child process: the parent's writes wait for the child to read
// (what the parent wrote when the child starts to: it asks, and reads once the parent answered).
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const CHUNK = 64 * 1024, TOTAL = 8 * 1024 * 1024;
if (process.argv[2] === 'server') {
  const hash = crypto.createHash('sha256');
  let received = 0;
  http.createServer((req, res) => {
    req.pause();
    setTimeout(() => {
      process.send('reading');
      process.once('message', () => {
        req.on('data', (d) => { received += d.length; hash.update(d); });
        req.on('end', () => res.end(received + ' ' + hash.digest('hex')));
        req.resume();
      });
    }, 500);
  }).listen(3062, () => process.send('ready'));
} else {
  const child = fork(__filename, ['server']);
  child.once('message', () => {
    const sent = crypto.createHash('sha256');
    let written = 0, falses = 0, atRead = -1;
    child.once('message', () => {
      atRead = written;
      child.send('go');
    });
    const r = http.request('http://localhost:3062/', { method: 'POST' }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        const [n, h] = b.split(' ');
        console.log(JSON.stringify({ written, falses: falses > 0, stalled: atRead >= 0 && atRead < TOTAL, received: Number(n), same: h === sent.digest('hex') }));
        child.kill();
        process.exit(0);
      });
    });
    const pump = () => {
      while (written < TOTAL) {
        const c = crypto.randomBytes(CHUNK);
        sent.update(c);
        written += c.length;
        if (!r.write(c)) { falses++; return void r.once('drain', pump); }
      }
      r.end();
    };
    pump();
  });
}
