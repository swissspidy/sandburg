// Client destroy/abort/end orderings against a server (here, or in a child: CHILD=1).
const http = require('http');
const PORT = Number(process.env.PORT || 3030);
const handler = (req, res) => {
  req.resume();
  if (req.url === '/silent') return;
  if (req.url === '/hold') { res.writeHead(200); res.write('a'); return; }
  req.on('end', () => res.end('ok'));
};
const cases = [];
const add = (name, url, act, opts = {}) => cases.push({ name, url, act, opts });
// When: 'sync' right after creating, 'socket' on its socket event, 'later' 20ms after, 'response' in its response callback, 'end' after its response ended.
for (const when of ['sync', 'socket', 'later', 'response', 'end']) {
  const url = when === 'response' ? '/hold' : when === 'end' ? '/ok' : '/silent';
  for (const how of ['destroy', 'destroyErr', 'abort', 'destroy+abort', 'abort+destroy', 'destroy+destroy', 'res.destroy']) {
    if (how === 'res.destroy' && when !== 'response' && when !== 'end') continue;
    add(`${when} ${how}`, url, how, { when });
  }
}
// A POST: destroyed or aborted mid-body, or before its end.
for (const how of ['destroy', 'abort', 'destroyErr']) add(`midbody ${how}`, '/ok', how, { when: 'later', post: true });

function run(c) {
  // Each from a timer's callback, as a program's code mostly runs (not a promise's continuation).
  return new Promise((done) => setTimeout(() => {
    const log = [];
    const push = (s) => log.push(s);
    const req = http.request(`http://localhost:${PORT}${c.url}`, { method: c.opts.post ? 'POST' : 'GET' });
    req.on('socket', () => { push('socket'); if (c.opts.when === 'socket') act(); });
    req.on('response', (res) => {
      push('response');
      res.on('aborted', () => push('res aborted'));
      res.on('error', (e) => push('res error ' + e.message));
      res.on('end', () => push('res end'));
      res.on('close', () => push('res close'));
      res.on('data', () => {});
      if (c.opts.when === 'response') act(res);
      if (c.opts.when === 'end') res.on('end', () => setTimeout(() => act(res), 5));
    });
    req.on('abort', () => push('abort'));
    req.on('error', (e) => push('error ' + e.message));
    req.on('close', () => push('close'));
    req.on('finish', () => push('finish'));
    if (c.opts.post) req.write('abc');
    else req.end();
    function act(res) {
      push('pre');
      const h = c.act;
      if (h === 'destroy') req.destroy();
      else if (h === 'destroyErr') req.destroy(new Error('mine'));
      else if (h === 'abort') req.abort();
      else if (h === 'destroy+abort') { req.destroy(); req.abort(); }
      else if (h === 'abort+destroy') { req.abort(); req.destroy(); }
      else if (h === 'destroy+destroy') { req.destroy(); req.destroy(new Error('second')); }
      else if (h === 'res.destroy') res.destroy();
      push('post');
      req.on('abort', () => push('late-abort'));
      process.nextTick(() => push('tick'));
      // (Not for a response destroyed by the program: its 'close' comes between process.nextTick's and
      // promises' in Node, which the runtime's process.nextTick, a microtask, cannot tell apart.)
      if (h !== 'res.destroy') Promise.resolve().then(() => push('promise'));
      setImmediate(() => push('immediate'));
    }
    if (c.opts.when === 'sync') act();
    if (c.opts.when === 'later') setTimeout(act, 20);
    setTimeout(() => done(`${c.name}: ${log.join(',')}`), 150);
  }, 1));
}

async function main() {
  const lines = [];
  for (const c of cases) lines.push(await run(c));
  console.log(lines.join('\n'));
  globalThis.child?.kill();
  process.exit(0);
}
if (process.env.CHILD) {
  const { fork } = require('child_process');
  const child = globalThis.child = fork(__dirname + '/destroy-order-server.cjs', [], { env: { ...process.env, PORT } });
  child.on('message', main);
} else http.createServer(handler).listen(PORT, main);
