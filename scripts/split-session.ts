/**
 * Splits src/orchestrator/session.ts into the Session and modules of what it uses, by moving
 * declarations as they are (scripts/split-module.ts), as scripts/split-worker.ts does for the
 * runtime. Run it on a tree where session.ts has not been split, then
 * `npm run typecheck && npm run lint`:
 *
 *   node scripts/split-session.ts
 *
 * Each move names declarations, not lines, so it can be run again on top of other branches' changes
 * to session.ts. A move fails (and nothing after it runs) when a name is no longer at the top level
 * of session.ts. The public types (SessionOptions, RunOptions, NodeRuntime, RunRenderer) and the
 * Session stay in session.ts, where the package's entry and the API report (api/sandburg.api.md)
 * find them. No moved declaration runs code when its module is evaluated, so the order things run
 * in does not change; the modules import nothing from session.ts but types.
 */
import { splitModule } from './split-module.ts';

const SESSION = 'src/orchestrator/session.ts';
const at = (p: string) => `src/orchestrator/${p}`;

splitModule(
  SESSION,
  at('launch.ts'),
  ['DEAD_PROXY', 'missingBrowser', 'WASM_TIERING_BUDGET', 'launchOptions', 'spkiHashes'],
  "How a session launches Chromium: its flags, the proxy that blocks what escapes the egress gateway,\nthe extra CAs it pins, and the advice when the browser is missing.",
);

splitModule(
  SESSION,
  at('run-state.ts'),
  ['PhaseTimeout', 'RpcError', 'RunState', 'unwrap', 'isInfra', 'serialize', 'ms', 'recordRequestFailures', 'recordDocuments'],
  "What a run records as it goes (RunState): its phases under their deadlines, the page's console,\nerrors, requests and documents, and the result it makes of them. The errors a run reports are\nSerializedErrors in its phases (a PhaseTimeout, an RpcError from the host page, or what a phase\nthrew), and the Failure that classify() makes of them.",
);

splitModule(
  SESSION,
  at('app-ready.ts'),
  [
    'appFrame',
    'waitForRender',
    'RELOAD_LOADING_PAGE_TRIES',
    'RELOAD_ERROR_PAGE_MS',
    'RENDER_GRACE_MS',
    'CONSOLE_GRACE_MS',
    'BENIGN_CONSOLE',
    'failFastOnAppError',
    'RUNTIME_FETCH_GRACE_MS',
    'failFastOnRuntimeFetch',
  ],
  "When the app is ready (the ready phase): its frame rendered something, past a dev server's loading\nand error pages; and when to stop waiting early, because the app threw or a runtime asset failed.",
);
