// Timers due together at the end of a turn each fire once, also when one of them queues an immediate
// (the next turn may start while the others still wait for theirs); one of them refreshed by another
// before its turn waits its time again.
const log = [];
const busy = () => setImmediate(() => {
  const end = Date.now() + 5;
  while (Date.now() < end);
});
busy();
setTimeout(() => {
  log.push('A');
  setImmediate(() => log.push('immediate from A'));
}, 1);
setTimeout(() => log.push('B'), 1);
setTimeout(() => log.push('C'), 1);
// Each part printed once its last event came (and a little later: anything after shows).
const once = (last, fn) => {
  const poll = setInterval(() => {
    if (!log.includes(last)) return;
    clearInterval(poll);
    setTimeout(fn, 20);
  }, 5);
};
once('immediate from A', () => {
  console.log(log.join(', '));
  log.length = 0;
  busy();
  let b;
  setTimeout(() => {
    log.push('A');
    b.refresh();
    setImmediate(() => log.push('immediate from A'));
  }, 1);
  b = setTimeout(() => log.push('B'), 1);
  setTimeout(() => log.push('C'), 1);
  once('B', () => console.log(log.join(', ')));
});
