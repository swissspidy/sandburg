// How a request's body is framed and when its server sees it: its headers, 'request' and each 'data'
// (against what the client did when: '>' marks), and a client gone mid-body.
const http = require('http');
let log;
http.createServer((req, res) => {
  const h = ['content-length', 'transfer-encoding'].map((k) => `${k}=${req.headers[k] ?? '-'}`).join(' ');
  log.push(`request ${req.method} ${h}`);
  req.on('data', (d) => log.push(`data ${d}`));
  req.on('end', () => { log.push(`end complete=${req.complete}`); res.end('ok'); });
  req.on('aborted', () => log.push('aborted'));
  req.on('error', (e) => log.push(`req error ${e.code} ${e.message}`));
  req.on('close', () => log.push('req close'));
  res.on('close', () => log.push('res close'));
}).listen(3032, async () => {
  const later = (ms, fn) => setTimeout(() => { log.push('>' + ms); fn(); }, ms);
  const cases = {
    'post write+end': (r) => { r.write('a'); r.end('b'); },
    'post end(data)': (r) => r.end('ab'),
    'post end()': (r) => r.end(),
    'get end()': (r) => r.end(),
    'get end(data)': (r) => r.end('ab'),
    'delete end(data)': (r) => r.end('ab'),
    'put length': (r) => { r.setHeader('content-length', 2); r.write('a'); r.end('b'); },
    'put length, later': (r) => { r.setHeader('content-length', 2); r.write('a'); later(100, () => r.end('b')); },
    'post flushHeaders': (r) => { r.flushHeaders(); later(100, () => r.end('a')); },
    'post slow': (r) => { r.write('a'); later(100, () => r.write('b')); later(200, () => r.end('c')); },
    'post same tick': (r) => { r.write('a'); r.write('b'); r.end('c'); },
    'post destroyed mid-body': (r) => { r.write('a'); later(100, () => r.destroy()); },
    'post aborted mid-body': (r) => { r.write('a'); later(100, () => r.abort()); },
    'post headers then destroyed': (r) => { r.flushHeaders(); later(100, () => r.destroy()); },
  };
  const lines = [];
  for (const [name, act] of Object.entries(cases)) {
    log = [];
    await new Promise((done) => {
      const method = name.split(' ')[0].toUpperCase();
      const r = http.request('http://localhost:3032/', { method }, (res) => { res.resume(); res.on('end', () => log.push('client response end')); });
      r.on('error', (e) => log.push(`client error ${e.message}`));
      act(r);
      setTimeout(done, 350);
    });
    lines.push(`${name}: ${log.join(', ')}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
});
