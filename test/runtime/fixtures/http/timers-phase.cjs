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
// 200 timers one after another, each alone (nothing else would run it): each fires. A lone timer whose
// wakeup is lost stalls the chain for good, so one bound for all 200 catches it, even though the bound's
// own timers phase runs the overdue one too. The bound is not how long 200 should take: a loaded runner
// took 27 ms a timer (5.4 s); with nothing lost they end well within it, and it is cleared.
const lone = (done) => {
  let n = 0;
  const bound = setTimeout(() => {
    out.push(`200 lone timers, one after another: all fired false (${n})`);
    done();
  }, 30000);
  const next = () => {
    if (++n < 200) return void setTimeout(next, 1);
    clearTimeout(bound);
    out.push('200 lone timers, one after another: all fired true');
    done();
  };
  setTimeout(next, 1);
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
// A timer set after a busy stretch counts from its end: one set before it with a longer delay comes
// first.
const busyThenShort = (done) => setTimeout(() => {
  const log = [];
  setTimeout(() => log.push('A'), 10);
  hold(20);
  setTimeout(() => log.push('B'), 1);
  setTimeout(() => {
    out.push(`set after a busy stretch: ${log.join(', ')}`);
    done();
  }, 50);
}, 1);
// Small numbers to clearTimeout() (another timer's, the browser's own) leave a timer whose number was
// not taken alone, as in Node.
const smallNumbers = (done) => {
  let fired = false;
  setTimeout(() => (fired = true), 10);
  for (let n = 1; n <= 5000; n++) clearTimeout(n);
  setTimeout(() => {
    out.push(`numbers 1 to 5000 cleared: it fired ${fired}`);
    done();
  }, 50);
};
// A timer that came due while a turn went (an immediate held the loop past its time), refreshed by
// a later immediate of that turn: due later now, it waits its time from the refresh. The timer is set
// in the immediate that holds, so no timers phase comes between its setting and the refresh: a timer
// of the program that fires late (a loaded runner) cannot let it run before it is refreshed.
const refreshedWhileDue = (done) => {
  let refreshed = NaN;
  let t;
  setImmediate(() => {
    t = setTimeout(() => {
      out.push(`refreshed while due: waited its time ${performance.now() - refreshed >= 98}`);
      done();
    }, 100);
    hold(150);
  });
  // (Its time passed: the immediates after go on, and it waits for them.)
  for (let i = 0; i < 50; i++) setImmediate(() => {});
  setImmediate(() => {
    t.refresh();
    refreshed = performance.now();
  });
};
const step = (fn) => new Promise((done) => fn(done));
void (async () => {
  await step(chained);
  await step(intervals);
  await step(intervalFirst);
  await step((done) => run('5 ms', 5, done));
  await step((done) => run('0 ms', 0, done));
  await step((done) => setImmediate(() => run('from an immediate', 5, done)));
  await step((done) => fs.readFile(__filename, () => run('from an I/O callback', 5, done)));
  await step(lone);
  await step(afterBlock);
  await step(busyThenShort);
  await step(smallNumbers);
  await step(refreshedWhileDue);
  console.log(out.join('\n'));
})();
