// Timers due together run in one timers phase: what one queues with process.nextTick or a promise runs
// before the next, and an immediate one queues waits for them all. Set from the main script, from an
// immediate, and from an I/O callback.
const fs = require('fs');
const out = [];
const run = (name, ms, done) => {
  const log = [];
  setTimeout(() => {
    log.push('a');
    process.nextTick(() => log.push('tick from a'));
    void Promise.resolve().then(() => log.push('promise from a'));
    setImmediate(() => log.push('imm from a'));
  }, ms);
  setTimeout(() => {
    log.push('b');
    process.nextTick(() => log.push('tick from b'));
  }, ms);
  setTimeout(() => log.push('c'), ms);
  // Once its last events came (and a little later: anything after shows).
  const poll = setInterval(() => {
    if (!['imm from a', 'c', 'tick from b'].every((e) => log.includes(e))) return;
    clearInterval(poll);
    setTimeout(() => {
      out.push(`${name}: ${log.join(', ')}`);
      done();
    }, 20);
  }, 5);
};
// Timers that timers of one phase set (after an await), in turn: in the order they came due.
const chained = (done) => {
  const log = [];
  const tick = (name) => new Promise((resolve) => setTimeout(() => {
    log.push(name);
    resolve();
  }, 1));
  const chain = async (name) => {
    await tick(name + '1');
    await tick(name + '2');
    log.push('end ' + name);
  };
  void Promise.all([chain('A'), chain('B')]).then(() => {
    out.push(`set in a timers phase: ${log.join(', ')}`);
    done();
  });
};
chained(() => run('5 ms', 5, () => run('0 ms', 0, () => setImmediate(() => run('from an immediate', 5, () => fs.readFile(__filename, () => run('from an I/O callback', 5, () => console.log(out.join('\n')))))))));
