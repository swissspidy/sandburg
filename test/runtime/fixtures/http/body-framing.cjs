// How a request's body is framed and when its server sees it: its headers, 'request' and each 'data'
// (against what the client did when: '>' marks, each 100 ms after the server saw what came before it,
// so that a body held back until its end never gets there), and a client gone mid-body.
const http = require('http');
let log;
/** What runs once the server logged an event (see after). */
let waits = [];
const push = (s) => {
  log.push(s);
  for (const w of waits.filter((x) => x.event === s)) {
    waits = waits.filter((x) => x !== w);
    w.fn();
  }
  over();
};
let over = () => {};
http.createServer((req, res) => {
  const h = ['content-length', 'transfer-encoding'].map((k) => `${k}=${req.headers[k] ?? '-'}`).join(' ');
  push(`request ${req.method}`);
  log[log.length - 1] += ' ' + h;
  req.on('data', (d) => push(`data ${d}`));
  req.on('end', () => { push(`end complete=${req.complete}`); res.end('ok'); });
  req.on('aborted', () => push('aborted'));
  req.on('error', (e) => push(`req error ${e.code} ${e.message}`));
  req.on('close', () => push('req close'));
  res.on('close', () => push('res close'));
}).listen(3032, async () => {
  // 100 ms after the server logged `event` (its request, a chunk): the client's next step, marked.
  let ms = 0;
  const after = (event, fn) => waits.push({ event, fn: () => setTimeout(() => { ms += 100; log.push('>' + ms); fn(); }, 100) });
  const cases = {
    'post write+end': (r) => { r.write('a'); r.end('b'); },
    'post end(data)': (r) => r.end('ab'),
    'post end()': (r) => r.end(),
    'get end()': (r) => r.end(),
    'get end(data)': (r) => r.end('ab'),
    'delete end(data)': (r) => r.end('ab'),
    'put length': (r) => { r.setHeader('content-length', 2); r.write('a'); r.end('b'); },
    'put length, later': (r) => { r.setHeader('content-length', 2); r.write('a'); after('data a', () => r.end('b')); },
    'post flushHeaders': (r) => { r.flushHeaders(); after('request POST', () => r.end('a')); },
    'post slow': (r) => { r.write('a'); after('data a', () => r.write('b')); after('data b', () => r.end('c')); },
    'post same tick': (r) => { r.write('a'); r.write('b'); r.end('c'); },
    'post destroyed mid-body': (r) => { r.write('a'); after('data a', () => r.destroy()); },
    'post aborted mid-body': (r) => { r.write('a'); after('data a', () => r.abort()); },
    'post headers then destroyed': (r) => { r.flushHeaders(); after('request POST', () => r.destroy()); },
  };
  const lines = [];
  for (const [name, act] of Object.entries(cases)) {
    log = [];
    waits = [];
    ms = 0;
    // Over once the server's request closed and the client's response ended or it failed (or TIMING).
    const late = await new Promise((done) => {
      const bound = setTimeout(() => done(true), 3000);
      over = () => {
        if (!log.includes('req close') || !log.some((e) => e === 'client response end' || e.startsWith('client error'))) return;
        clearTimeout(bound);
        done(false);
      };
      const method = name.split(' ')[0].toUpperCase();
      const r = http.request('http://localhost:3032/', { method }, (res) => { res.resume(); res.on('end', () => push('client response end')); });
      r.on('error', (e) => push(`client error ${e.message}`));
      act(r);
    });
    lines.push(`${name}: ${log.join(', ')}${late ? ' | TIMING: not over in 3000 ms' : ''}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
});
