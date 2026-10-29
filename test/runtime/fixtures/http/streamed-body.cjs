// A request body streams to its server, in this process or another (TOPOLOGY: here, child server, child
// client, siblings): the client writes the next chunk only once the server echoed the last one; destroyed
// mid-body, the server sees it; a server's timeouts apply across processes.
const http = require('http');
const { fork } = require('child_process');
const PORT = 3070;
const role = process.argv[2] ?? 'main';
function serve(report) {
  http.createServer((req, res) => {
    const log = [];
    const h = ['content-length', 'transfer-encoding'].map((k) => `${k}=${req.headers[k] ?? '-'}`).join(' ');
    log.push(`request ${req.url} ${h}`);
    req.on('aborted', () => log.push('aborted'));
    req.on('error', (e) => log.push(`req error ${e.code}`));
    req.on('close', () => { log.push('req close'); setTimeout(() => report(log.join(', ')), 50); });
    if (req.url === '/echo') {
      res.writeHead(200);
      req.on('data', (d) => { log.push(`data ${d}`); res.write(String(d).toUpperCase()); });
      req.on('end', () => { log.push('end'); res.end('.'); });
    } else if (req.url === '/continue') {
      // Expect: 100-continue: this server's 'checkContinue' lets it go on (the client sends its body then).
      req.on('data', (d) => log.push(`data ${d}`));
      req.on('end', () => res.end('ok'));
    } else if (req.url === '/timeout') res.setTimeout(150, () => { log.push('res timeout'); res.end('late'); });
    else if (req.url === '/idle') req.socket.setTimeout(150);
    // (Its client goes once this server has seen the chunk: it echoes it.)
    else req.on('data', (d) => { log.push(`data ${d}`); res.writeHead(200); res.write(String(d).toUpperCase()); });
  }).on('checkContinue', (req, res) => {
    res.writeContinue();
    res.writeEarlyHints({ link: '</a.css>; rel=preload' });
    req.socket.server.emit('request', req, res);
  }).listen(PORT, () => report('listening'));
}
async function client() {
  const lines = [];
  const one = (path, act, headers = {}) => new Promise((done) => {
    const log = [];
    const r = http.request(`http://localhost:${PORT}${path}`, { method: 'POST', headers }, (res) => {
      res.on('data', (d) => { log.push(`got ${d}`); r.emit('echo', String(d)); });
      res.on('end', () => {
        log.push('client end');
        settle();
      });
      res.on('error', () => {});
    });
    r.on('error', (e) => log.push('client error ' + e.message));
    r.on('information', (info) => log.push(`information ${info.statusCode} ${JSON.stringify(info.headers)}`));
    act(r, log);
    // Over once its response ended, it failed or the request closed (destroyed once a response
    // started, it does neither), and a little later (anything after shows), or a TIMING failure if
    // that takes too long.
    let over = false;
    const settle = () => {
      if (over) return;
      over = true;
      setTimeout(() => finish(false), 20);
    };
    const finish = (late) => {
      clearTimeout(bound);
      over = true;
      lines.push(`client ${path}: ${log.join(', ')}${late ? ' | TIMING: not over in 3000 ms' : ''}`);
      done();
    };
    const bound = setTimeout(() => finish(true), 3000);
    r.on('close', settle);
    r.on('error', settle);
  });
  await one('/echo', (r) => {
    const next = ['b', 'c'];
    r.on('echo', (d) => {
      if (d === '.') return;
      if (next.length) r.write(next.shift());
      else r.end();
    });
    r.write('a');
  });
  await one('/continue', (r) => {
    r.on('continue', () => r.end('after continue'));
    r.flushHeaders();
  }, { expect: '100-continue' });
  await one('/mid', (r) => { r.write('a'); r.once('echo', () => r.destroy()); });
  await one('/timeout', (r) => r.write('a'));
  await one('/idle', (r) => r.write('a'));
  return lines.join('\n');
}
const topology = process.env.TOPOLOGY ?? 'here';
if (role === 'server') serve((m) => process.send(m));
else if (role === 'client') void client().then((out) => process.send(out));
else {
  const server = [];
  const print = (out) => console.log(out + '\n' + server.map((s) => 'server ' + s).join('\n'));
  const children = [];
  // Once the server reported each of its four requests (it does after each closed), or TIMING.
  const SERVER_LINES = 4;
  const end = (out) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const late = Date.now() - started > 3000;
      if (server.length < SERVER_LINES && !late) return;
      clearInterval(poll);
      print(out + (late ? '\nTIMING: the server reported ' + server.length + ' of ' + SERVER_LINES + ' in 3000 ms' : ''));
      for (const c of children) c.kill();
      process.exit(0);
    }, 10);
  };
  const onServer = (m, start) => (m === 'listening' ? start() : server.push(m));
  const forkClient = () => { const c = fork(__filename, ['client']); children.push(c); c.on('message', end); };
  if (topology === 'here') serve((m) => onServer(m, () => client().then(end)));
  else if (topology === 'child client') serve((m) => onServer(m, forkClient));
  else {
    const s = fork(__filename, ['server']);
    children.push(s);
    s.on('message', (m) => onServer(m, topology === 'child server' ? () => client().then(end) : forkClient));
  }
}
