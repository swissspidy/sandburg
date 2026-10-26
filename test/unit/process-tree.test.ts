/** The runtime's count of processes still starting (src/node-runtime/process-tree.ts), which pagePort waits on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initProcessTree, nestedEnded, nestedReported, nestedStarted, serversChanged, shellStepsAhead } from '../../src/node-runtime/process-tree.ts';

test('a process counts as starting until it serves a port, or only waits on child processes that do', () => {
  const posted: number[] = [];
  let serving = false;
  initProcessTree({ process: true, serving: () => serving, post: (m) => posted.push(m.count) });
  assert.deepEqual(posted, [1], 'the program, before it runs anything');

  // `node prep.js && node server.js`: the shell (in this runtime) runs prep.js, then server.js.
  const prep = {};
  nestedStarted(prep, true);
  assert.deepEqual(posted, [1], 'the program waits on prep.js, which is starting');
  nestedReported(prep, 1);
  // A worker thread of the program is part of it, not a process to wait on.
  const thread = {};
  nestedStarted(thread, false);
  nestedReported(thread, 0);
  nestedEnded(prep);
  nestedEnded(thread);
  assert.deepEqual(posted, [1], 'between the commands, the program itself is starting');
  const server = {};
  nestedStarted(server, true);
  nestedReported(server, 1);
  assert.deepEqual(posted, [1]);
  nestedReported(server, 0);
  assert.deepEqual(posted, [1, 0], 'server.js listens: none is starting');

  // `concurrently "node api.js" "ng serve"`: an API that listens, and a dev server still compiling.
  nestedEnded(server);
  const concurrently = {};
  nestedStarted(concurrently, true);
  nestedReported(concurrently, 1);
  assert.deepEqual(posted, [1, 0, 1]);
  serving = true;
  serversChanged();
  assert.deepEqual(posted, [1, 0, 1], 'the program serving a port does not cover a child still starting');
  nestedEnded(concurrently);
  assert.deepEqual(posted, [1, 0, 1, 0]);
  serving = false;
  serversChanged();
  assert.deepEqual(posted, [1, 0, 1, 0, 1], 'a server that closed is no longer up');

  // `node api.js & sleep 2 && vite`: the API listens while the shell sleeps, with vite still to start.
  const api = {};
  nestedStarted(api, true);
  shellStepsAhead(1);
  nestedReported(api, 0);
  assert.deepEqual(posted, [1, 0, 1, 0, 1, 2, 1], 'sleeping, with a command still to start');
  shellStepsAhead(-1);
  assert.deepEqual(posted, [1, 0, 1, 0, 1, 2, 1, 0], 'its last command is all that is left (here: none)');
  nestedEnded(api);

  // A report from a runtime that ended, or never started here, changes nothing.
  nestedReported(concurrently, 5);
  nestedReported({}, 5);
  assert.deepEqual(posted, [1, 0, 1, 0, 1, 2, 1, 0, 1]);
});
