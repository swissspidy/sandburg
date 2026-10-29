// Timers due together run in one timers phase: what one queues with process.nextTick or a promise runs
// before the next, and an immediate one queues waits for them all. Set from the main script, from an
// immediate, and from an I/O callback.
const fs = require('fs');
const out = [];
// The loop held past their time once they are set, so that they surely come due together (else a
// millisecond boundary between them can part them, in Node too: about 1 run in 100).
const hold = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
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
  hold(ms + 10);
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
// An interval due with a timeout is in the same phase, in the order they were set; it runs again
// (its handle the same) until cleared.
const intervals = (done) => {
  const log = [];
  const finish = () => setTimeout(() => {
    out.push(`intervals: ${log.join(', ')}`);
    done();
  }, 20);
  setTimeout(() => {
    log.push('t');
    setImmediate(() => log.push('it'));
  }, 10);
  const iv = setInterval(() => {
    log.push('iv');
    clearInterval(iv);
  }, 10);
  hold(20);
  setTimeout(() => {
    // Each run about its time after the one before (10 ms; Node: from about 8 ms, more rarely less).
    const runs = [];
    const iv2 = setInterval(() => {
      runs.push(performance.now());
      log.push('iv2');
      setImmediate(() => log.push('iiv2'));
      if (log.filter((e) => e === 'iv2').length === 3) {
        log.push(`same handle ${+iv2 === +handle}, spaced ${runs.slice(1).every((t, i) => t - runs[i] >= 3)}`);
        clearInterval(iv2);
        finish();
      }
    }, 10);
    const handle = iv2;
  }, 40);
};
// The interval set first, and its callback queues an immediate: it waits for the timeout after it.
const intervalFirst = (done) => {
  const log = [];
  const iv = setInterval(() => {
    log.push('iv');
    clearInterval(iv);
    setImmediate(() => {
      log.push('iiv');
      setTimeout(() => {
        out.push(`interval first: ${log.join(', ')}`);
        done();
      }, 20);
    });
  }, 10);
  setTimeout(() => log.push('t'), 10);
  hold(20);
};
// Unheld, 300 times: timers set together are due together (their time, in whole ms), so the
// first one's immediate comes after the others nearly always; in Node about 97 runs in 100.
const together = (done) => {
  let parted = 0, n = 0;
  const one = () => {
    const log = [];
    setTimeout(() => {
      log.push('a');
      setImmediate(() => log.push('imm'));
    }, 0);
    setTimeout(() => log.push('b'), 0);
    setTimeout(() => log.push('c'), 0);
    setTimeout(() => {
      if (log.join() !== 'a,b,c,imm') parted++;
      if (++n < 300) setImmediate(one);
      else {
        out.push(`set together, 300 times: in one phase at least 9 in 10: ${parted <= 30}`);
        done();
      }
    }, 5);
  };
  one();
};
// A timer set at the end of a long synchronous block (another set at its start) waits its time from
// then, not from the block's start (a compile, as esbuild's: else it fires at once).
const afterBlock = (done) => setTimeout(() => {
  setTimeout(() => {}, 1);
  hold(300);
  const set = performance.now();
  setTimeout(() => {
    out.push(`set after a long block: waited its time ${performance.now() - set >= 195}`);
    done();
  }, 200);
}, 1);
const step = (fn) => new Promise((done) => fn(done));
void (async () => {
  await step(chained);
  await step(intervals);
  await step(intervalFirst);
  await step((done) => run('5 ms', 5, done));
  await step((done) => run('0 ms', 0, done));
  await step((done) => setImmediate(() => run('from an immediate', 5, done)));
  await step((done) => fs.readFile(__filename, () => run('from an I/O callback', 5, done)));
  await step(together);
  await step(afterBlock);
  console.log(out.join('\n'));
})();
