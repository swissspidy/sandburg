/**
 * The runtime's script as an ES module, imported by a small classic script (ADR NNNN).
 *
 * Every runtime of a run (the program's, its spares, worker threads and child processes: a Vite run
 * starts 6-8) compiles the runtime's 0.86 MB script again: Chromium gives a dedicated worker's
 * classic scripts no compiled code (not its own script, not importScripts), and a run's browser
 * context is off the record, with no code cache on disk. One kind of script does get V8's code in
 * such a context: a module a worker imports with import(), answered by the service worker from Cache
 * Storage. Its code is kept beside the Cache Storage entry once the first runtime has evaluated the
 * module (with the functions that evaluation ran: the runtime's boot), and every later runtime of the
 * run takes it from there instead of compiling.
 *
 * The worker's script (/__sandburg/node-worker.js) holds the messages it gets until the module has
 * run, then hands them on in order; a module that fails to load fails the worker as a script that
 * fails to load does. The module's URL names the digest of its text: the service worker keeps it
 * under that URL, and the host answers only the current text's digest.
 */

/** Where the runtime's module is served: /__sandburg/runtime/<sha-256 of its text>.mjs. */
export const RUNTIME_MODULE = /^\/__sandburg\/runtime\/([0-9a-f]{64})\.mjs$/;

/**
 * The worker's classic script for the runtime module of `digest`. A spare (bundle.ts's
 * SPARE_SCRIPT) loads it with importScripts and hands its first message on at once: it is held here
 * with the others.
 */
export function runtimeBootstrap(digest: string): string {
  return `"use strict";
(() => {
  // Taken now: the runtime hides the worker's globals as it starts its program (self, location, ...).
  const scope = self;
  const Message = MessageEvent;
  const held = [];
  const hold = (e) => {
    e.stopImmediatePropagation();
    held.push(e);
  };
  scope.addEventListener('message', hold);
  import(new URL('runtime/${digest}.mjs', location.href).href).then(
    () => {
      scope.removeEventListener('message', hold);
      for (const e of held) scope.dispatchEvent(new Message('message', { data: e.data, ports: [...e.ports] }));
    },
    (err) => {
      scope.removeEventListener('message', hold);
      setTimeout(() => {
        throw err;
      });
    },
  );
})();
`;
}
