// The loop's phases as the runtime keeps them: what an immediate or a close callback queues
// (process.nextTick, promises) runs before the next one; close callbacks run last-closed first,
// after the immediates queued before them; an immediate queued in one runs on the next turn.
const http = require('http');
const log = [];
http.createServer(() => {}).listen(3080, () => {
  const reqs = [1, 2, 3].map((i) => {
    const r = http.get('http://localhost:3080/');
    r.on('error', () => {});
    r.on('close', () => {
      log.push('close ' + i);
      process.nextTick(() => log.push('tick after close ' + i));
      if (i === 1) setImmediate(() => log.push('immediate from close'));
    });
    return r;
  });
  setTimeout(() => {
    for (const r of reqs) r.destroy();
    setImmediate(() => {
      log.push('immediate 1');
      process.nextTick(() => log.push('tick after immediate 1'));
      void Promise.resolve().then(() => log.push('promise after immediate 1'));
      setImmediate(() => log.push('immediate from immediate 1'));
    });
    setImmediate(() => log.push('immediate 2'));
    setTimeout(() => {
      console.log(log.join('\n'));
      process.exit(0);
    }, 100);
  }, 50);
});
