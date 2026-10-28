// Timers due together at the end of a turn each fire once, also when one of them queues an immediate
// (the next turn may start while the others still wait for theirs).
const log = [];
setImmediate(() => {
  const end = Date.now() + 5;
  while (Date.now() < end);
});
setTimeout(() => {
  log.push('A');
  setImmediate(() => log.push('immediate from A'));
}, 1);
setTimeout(() => log.push('B'), 1);
setTimeout(() => log.push('C'), 1);
setTimeout(() => console.log(log.join(', ')), 100);
