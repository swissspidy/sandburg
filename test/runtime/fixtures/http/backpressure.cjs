// Backpressure: a client writing as fast as 'drain' lets it, to a server that reads nothing for 500 ms, then all.
const http = require('http');
const crypto = require('crypto');
const CHUNK = 64 * 1024, TOTAL = 8 * 1024 * 1024;
let received = 0;
const hash = crypto.createHash('sha256');
http.createServer((req, res) => {
  req.pause();
  setTimeout(() => {
    req.on('data', (d) => { received += d.length; hash.update(d); });
    req.on('end', () => res.end(String(received)));
    req.resume();
  }, 500);
}).listen(3061, () => {
  const sent = crypto.createHash('sha256');
  let written = 0, falses = 0, at500 = -1;
  const r = http.request('http://localhost:3061/', { method: 'POST' }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => {
      console.log(JSON.stringify({ written, falses: falses > 0, stalled: at500 < TOTAL, received: Number(b), same: hash.digest('hex') === sent.digest('hex') }));
      process.exit(0);
    });
  });
  setTimeout(() => (at500 = written), 450);
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
