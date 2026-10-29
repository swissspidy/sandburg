// A request that waits for its socket (an agent's maxSockets) emits 'finish' only once it went out; a
// client that asks for Connection: close has its connection closed once its response ended. Each step
// follows the last's event (with time for a wrong one to show), and a TIMING failure if it never comes.
const http = require('http');
const log = [];
let waits = [];
const push = (s) => {
  log.push(s);
  for (const w of waits.filter((x) => x.event === s)) {
    waits = waits.filter((x) => x !== w);
    w.fn();
  }
};
const after = (event, ms, fn) => waits.push({ event, fn: () => setTimeout(fn, ms) });
const bound = setTimeout(() => {
  console.log(log.join('\n') + '\nTIMING: not over in 5000 ms');
  process.exit(0);
}, 5000);
http.createServer((req, res) => {
  push('request ' + req.url);
  req.socket.on('close', () => push('server socket close ' + req.url));
  if (req.url !== '/held') res.end('ok');
}).listen(3081, () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const held = http.get('http://localhost:3081/held', { agent });
  held.on('error', () => {});
  const next = http.get('http://localhost:3081/next', { agent }, (res) => {
    res.resume();
    res.on('end', () => push('next end'));
  });
  next.on('socket', () => push('next socket'));
  next.on('finish', () => push('next finish'));
  after('request /held', 100, () => {
    push('destroy held');
    held.destroy();
  });
  // Its connection closes as its response ended, not as a kept-alive one would (4 s later).
  let ended = NaN;
  after('next end', 50, () => {
    http.get('http://localhost:3081/close', { headers: { connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => (ended = performance.now()));
    });
  });
  after('server socket close /close', 50, () => {
    clearTimeout(bound);
    const gap = performance.now() - 50 - ended;
    // (Its own step: not in Node's output before.)
    console.log(log.filter((e) => e !== 'next end').join('\n') + (gap <= 1000 ? '' : `\nTIMING: its connection closed ${Math.round(gap)} ms after the response (expected at most 1000)`));
    process.exit(0);
  });
});
