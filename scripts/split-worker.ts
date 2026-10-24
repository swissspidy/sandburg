/**
 * Splits src/node-runtime/worker.ts into cohesive modules, by moving declarations as they are
 * (scripts/split-module.ts): no code is edited, only imports and exports. Run it on a tree where
 * worker.ts has not been split, then `npm run typecheck && npm run lint`:
 *
 *   node scripts/split-worker.ts
 *
 * It was written to be re-applied on top of other branches' changes to worker.ts: each move names
 * declarations, not lines. A move fails (and nothing after it runs) when a name is no longer at the
 * top level of worker.ts; a declaration added since that the moved code uses is imported from
 * worker.ts. The runtime's script (bundle.ts) is one esbuild bundle either way: esbuild hoists the
 * modules into one scope, so the split changes neither what runs nor in which order.
 */
import { splitModule } from './split-module.ts';

const WORKER = 'src/node-runtime/worker.ts';
const at = (p: string) => `src/node-runtime/${p}`;

/** The messages between the page and runtimes, with the other way's (FromWorker, ToParent). */
splitModule(WORKER, at('messages.ts'), ['ToWorker', 'SharedPreload']);

splitModule(
  WORKER,
  at('buffer-patches.ts'),
  ['patchBase64Url', 'patchUtf8', 'patchHashCopy', 'utf8Length', 'patchBase64'],
  "The buffer polyfill's patches: what Node's Buffer does that the polyfill does not, or does slowly.\nworker.ts applies them before any program runs.",
);

splitModule(WORKER, at('async-context.ts'), ['EventEmitterAsyncResource']);

splitModule(
  WORKER,
  at('host-files.ts'),
  [
    'readBundle',
    'stillDownloading',
    'prefetchedBody',
    'bundleFiles',
    'onSide',
    'downloadOnSide',
    'downloadedOnSide',
    'waitedForChannel',
    'installedRequests',
    'PRELOAD_AFTER',
    'PRELOAD_AFTER_THREAD',
    'syncGet',
    'compilesLoaded',
    'loadCompiles',
    'requestSync',
    'NativeWorker',
    'workerHref',
    'nativeWorkerPost',
    'DIGEST_HELPER',
    'digester',
    'startDigester',
    'channel',
    'CHANNEL_MAILBOX',
    'openChannel',
    'shareChannel',
    'useChannel',
    'viaChannel',
    'digestOf',
    'hexOf',
    'written',
    'toDigest',
    'nativeSetTimeout',
    'digestWhenWritten',
    'digestWritten',
    'writtenDigest',
    'ASK_FIRST',
    'MAILBOX_HEADER',
    'compileInPage',
    'connectPageCompiler',
    'installedFile',
  ],
  "How a runtime gets files from the host and the page: bundles and files downloaded on the side,\nsynchronous requests, the file channel and its digests, and the page's compiler (ADR 0029).\nThe preload bundle and its shared copy stay in worker.ts, which init sets up.",
);

splitModule(
  WORKER,
  at('builtins.ts'),
  ['buildBuiltins'],
  "The runtime's built-in modules (node:fs, node:stream, node:util, …), built once per runtime by\ninit (worker.ts) from the polyfills and the runtime's own modules (builtins/).",
);

splitModule(
  WORKER,
  at('peers.ts'),
  [
    'Send',
    'netConns',
    'nestedNet',
    'nextNetId',
    'bindRemote',
    'stmt:netLinks.connect =',
    "stmt:netEvents.on('listening'",
    'netMessage',
    'nestedPorts',
    'nestedSockets',
    'loopbackRequests',
    'nextLoopbackId',
    'stmt:loopback.route =',
    'loopbackReply',
    'loopbackRequest',
    'relayFromNested',
  ],
  'Between runtimes (a runtime, its worker threads and child processes): net connections, and\nrequests and WebSockets to servers in another runtime, routed down or up (ADR 0006).',
);
