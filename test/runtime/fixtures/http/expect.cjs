// Expect: 100-continue and other informational responses: 'continue' and 'information' on the client,
// 'checkContinue' and 'checkExpectation' on the server (a 417 without a listener).
const http = require('http');
const lines = [];
const run = (name, setup, headers, client) => new Promise((done) => {
  const log = [];
  const s = http.createServer();
  setup(s, log);
  s.listen(0, () => {
    const r = http.request(`http://localhost:${s.address().port}/`, { method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => log.push(`client response ${res.statusCode} ${JSON.stringify(b)}`));
    });
    r.on('continue', () => {
      log.push('client continue');
      r.end('body');
    });
    r.on('information', (info) => log.push(`client information ${info.statusCode} ${info.statusMessage} ${JSON.stringify(info.headers)}`));
    r.on('error', (e) => log.push('client error ' + e.message));
    client(r);
    // Over once the client's response ended or it failed, and a little later (anything after shows),
    // or a TIMING failure if that takes too long.
    const finish = (late) => {
      clearInterval(poll);
      lines.push(`${name}: ${log.join(', ')}${late ? ' | TIMING: not over in 3000 ms' : ''}`);
      s.closeAllConnections();
      s.close();
      done();
    };
    const started = Date.now();
    const poll = setInterval(() => {
      if (log.some((e) => e.startsWith('client response') || e.startsWith('client error'))) {
        clearInterval(poll);
        setTimeout(() => finish(false), 20);
      } else if (Date.now() - started > 3000) finish(true);
    }, 10);
  });
});
const echo = (log) => (req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    log.push(`server body ${JSON.stringify(b)}`);
    res.end('ok');
  });
};
void (async () => {
  await run('100-continue', (s, log) => s.on('request', (req, res) => { log.push('server request'); echo(log)(req, res); }), { expect: '100-continue' }, (r) => r.flushHeaders());
  await run('checkContinue, continued', (s, log) => {
    s.on('request', () => log.push('server request'));
    s.on('checkContinue', (req, res) => {
      log.push('server checkContinue');
      res.writeContinue();
      echo(log)(req, res);
    });
  }, { expect: '100-continue' }, (r) => r.flushHeaders());
  await run('checkContinue, refused', (s, log) => s.on('checkContinue', (req, res) => {
    log.push('server checkContinue');
    res.writeHead(417);
    res.end('no');
  }), { expect: '100-continue' }, (r) => r.flushHeaders());
  await run('other expectation', (s, log) => s.on('request', () => log.push('server request')), { expect: 'something' }, (r) => r.end('x'));
  await run('checkExpectation', (s, log) => s.on('checkExpectation', (req, res) => {
    log.push(`server checkExpectation ${req.headers.expect}`);
    res.end('checked');
  }), { expect: 'something' }, (r) => r.end('x'));
  await run('early hints', (s, log) => s.on('request', (req, res) => {
    res.writeEarlyHints({ link: '</a.css>; rel=preload' });
    res.writeProcessing();
    echo(log)(req, res);
  }), {}, (r) => r.end('y'));
  console.log(lines.join('\n'));
  process.exit(0);
})();
