/** The runtime's count of processes still starting (src/node-runtime/process-tree.ts), which pagePort waits on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devScriptRunning, initProcessTree, nestedEnded, nestedReported, nestedStarted, serversChanged, shellStepsAhead } from '../../src/node-runtime/process-tree.ts';

test('a process counts as starting until it serves a port; only the dev script\'s own program waits on its commands', () => {
  // The module's state is this runtime's: one walk through, in order.
  const posted: number[] = [];
  const last = () => posted[posted.length - 1];
  let serving = false;
  initProcessTree({ process: true, serving: () => serving, post: (m) => posted.push(m.count) });
  assert.equal(last(), 1, 'the program, before it runs anything');

  // A program of the app's that forks an API (which listens) and then starts its own page's server
  // (`node dev.js`): it is starting until that server listens, whatever its child does.
  const forked = {};
  nestedStarted(forked, true);
  nestedReported(forked, 0);
  assert.equal(last(), 1, 'the API listens; the program has not');
  serving = true;
  serversChanged();
  assert.equal(last(), 0, 'its own server listens');
  serving = false;
  serversChanged();
  assert.equal(last(), 1, 'a server that closed is no longer up');
  nestedEnded(forked);

  // Sandburg's program for the dev script `node prep.js && node server.js`: its shell runs prep.js,
  // then server.js; the program only waits on them.
  devScriptRunning(1);
  const prep = {};
  shellStepsAhead(1);
  nestedStarted(prep, true);
  nestedReported(prep, 1);
  assert.equal(last(), 2, 'prep.js starting, with server.js still to start');
  // A worker thread of the program is part of it, not a process to wait on.
  const thread = {};
  nestedStarted(thread, false);
  nestedReported(thread, 0);
  nestedEnded(thread);
  nestedEnded(prep);
  shellStepsAhead(-1);
  assert.equal(last(), 1, 'between the commands, the program itself is starting');
  const server = {};
  nestedStarted(server, true);
  assert.equal(last(), 1, 'server.js counts as starting until it reports');
  nestedReported(server, 0);
  assert.equal(last(), 0, 'server.js listens: none is starting');
  nestedEnded(server);

  // `concurrently "node api.js" "ng serve"`: concurrently (a program with children) counts itself.
  const concurrently = {};
  nestedStarted(concurrently, true);
  nestedReported(concurrently, 1);
  assert.equal(last(), 1);
  nestedEnded(concurrently);

  // `node api.js & sleep 2 && vite`: the API listens while the shell sleeps, with vite still to start.
  const api = {};
  nestedStarted(api, true);
  shellStepsAhead(1);
  nestedReported(api, 0);
  assert.equal(last(), 1, 'sleeping, with a command still to start');
  shellStepsAhead(-1);
  const vite = {};
  nestedStarted(vite, true);
  nestedReported(vite, 0);
  assert.equal(last(), 0, 'both serve');

  // A report from a runtime that ended, or never started here, changes nothing.
  const before = posted.length;
  nestedEnded(vite);
  nestedReported(vite, 5);
  nestedReported({}, 5);
  assert.equal(posted.length, before);
  nestedEnded(api);
  devScriptRunning(-1);
  assert.equal(last(), 1, 'the dev script ended: the program counts itself again');
});
