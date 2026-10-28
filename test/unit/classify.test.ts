import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ClassifyInput } from '../../src/classify.ts';
import type { CheckResult, PhaseRecord } from '../../src/types.ts';

const ok = (name: PhaseRecord['name']): PhaseRecord => ({ name, status: 'ok', durationMs: 1 });
const allOk = (['probe', 'load', 'mount', 'install', 'start', 'ready', 'checks'] as const).map(ok);

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return { probe: { verdict: 'supported' }, phases: allOk, checks: [], pageErrors: [], infraError: null, declaredDependencies: ['react'], ...over };
}

function failedAt(name: PhaseRecord['name'], message: string, code?: string, status: 'failed' | 'timeout' = 'failed'): PhaseRecord[] {
  const idx = allOk.findIndex((p) => p.name === name);
  return [...allOk.slice(0, idx), { name, status, durationMs: 1, error: { name: 'Error', message, code } }];
}

const failedCheck: CheckResult = { id: 'functional:x', kind: 'functional', name: 'x', status: 'failed', blocking: true, durationMs: 1, message: 'expected 1' };

test('a clean run has no failure', () => {
  assert.equal(classify(input({})), null);
});

test('informational check failures do not create a failure', () => {
  assert.equal(classify(input({ checks: [{ ...failedCheck, kind: 'axe', blocking: false }] })), null);
});

test('timeouts win over everything else', () => {
  const f = classify(input({ phases: failedAt('ready', 'ready did not finish', 'UNSUPPORTED', 'timeout') }));
  assert.equal(f?.class, 'timeout');
  assert.equal(f?.rule, 'phase-deadline');
});

test('infra errors are infra', () => {
  const f = classify(input({ phases: failedAt('load', 'Target crashed'), infraError: { phase: 'load', message: 'Target crashed' } }));
  assert.equal(f?.class, 'infra');
});

test('probe verdict unsupported is runtime-unsupported', () => {
  const f = classify(input({ probe: { verdict: 'unsupported', reason: 'next' }, phases: [ok('probe')] }));
  assert.deepEqual([f?.class, f?.rule], ['runtime-unsupported', 'probe-unsupported']);
});

test('adapter error codes map directly', () => {
  assert.equal(classify(input({ phases: failedAt('install', 'file: deps', 'UNSUPPORTED') }))?.class, 'runtime-unsupported');
  assert.equal(classify(input({ phases: failedAt('mount', 'no index.html', 'APP') }))?.class, 'app-bug');
});

test('runtime signatures are runtime-unsupported', () => {
  const f = classify(input({
    phases: failedAt('ready', 'waiting for render'),
    pageErrors: [{ source: 'app', message: 'Failed to resolve module specifier "react". Relative references must start with either "/", "./", or "../".' }],
  }));
  assert.deepEqual([f?.class, f?.rule], ['runtime-unsupported', 'signature:bare-specifier']);
});

test('importing an undeclared package is an app bug', () => {
  const f = classify(input({
    phases: failedAt('ready', 'waiting for render'),
    pageErrors: [{ source: 'app', message: 'Failed to resolve module specifier "lodash/debounce".' }],
  }));
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'undeclared-import']);
});

test('errors thrown from project sources before render are app bugs', () => {
  const f = classify(input({
    phases: failedAt('ready', 'waiting for render'),
    pageErrors: [{ source: 'app', message: 'x is not defined', stack: 'ReferenceError: x is not defined\n    at App (http://r-1.sandburg.localhost:1/__virtual__/5173/src/App.tsx:3:9)' }],
  }));
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'app-error-before-ready']);
});

test('failed blocking checks on a healthy runtime are app bugs', () => {
  const f = classify(input({ checks: [failedCheck] }));
  assert.deepEqual([f?.class, f?.phase, f?.rule], ['app-bug', 'checks', 'blocking-check-failed']);
});

test('unexplained failures stay unknown', () => {
  const f = classify(input({ phases: failedAt('start', 'something odd') }));
  assert.deepEqual([f?.class, f?.rule], ['unknown', 'unmatched']);
});

test('a failing dispose never decides the classification', () => {
  const phases: PhaseRecord[] = [...allOk, { name: 'dispose', status: 'timeout', durationMs: 10_000, error: { name: 'PhaseTimeout', message: 'dispose did not finish' } }];
  assert.equal(classify(input({ phases })), null);
  assert.equal(classify(input({ phases, checks: [failedCheck] }))?.rule, 'blocking-check-failed');
});

test('a missing Node.js built-in is a runtime limitation', () => {
  const f = classify(input({ phases: failedAt('start', `"next dev" exited with code 1: Cannot find module 'dns/promises' from '/app/x.js'`) }));
  assert.deepEqual([f?.class, f?.rule], ['runtime-unsupported', 'signature:missing-builtin']);
  // A package the project never declared is the app's bug, wherever the import fails.
  const g = classify(input({ phases: failedAt('start', `Cannot find module 'left-pad' from '/x.js'`) }));
  assert.deepEqual([g?.class, g?.rule], ['app-bug', 'undeclared-import']);
});

test('compile errors in project sources are app bugs', () => {
  const f = classify(input({ phases: failedAt('ready', 'app threw before rendering: Module build failed (from ./node_modules/next/dist/build/webpack/loaders/next-swc-loader.js):') }));
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'compile-error']);
  const g = classify(input({ phases: failedAt('ready', 'waiting'), pageErrors: [{ source: 'app', message: 'Transform failed with 1 error:\n/src/App.tsx:3:15: ERROR: Unexpected ";"' }] }));
  assert.equal(g?.rule, 'compile-error');
});

test('a runtime download that came back broken is infra', () => {
  const f = classify(input({ phases: failedAt('mount', 'PHP.run() failed with exit code 255.\nUncaught Exception: Could not unzip file. Error code: 19. File size: 960 bytes.') }));
  assert.deepEqual([f?.class, f?.rule], ['infra', 'signature:download-failed']);
});

test('a runtime that cannot fetch its own code while booting is infra', () => {
  const f = classify(input({ phases: failedAt('mount', 'Failed to fetch dynamically imported module: https://cdn.example.org/runtime/index-BG9JLHps.js') }));
  assert.deepEqual([f?.class, f?.rule], ['infra', 'runtime-boot-fetch']);
  // The same text once the app is running is not infra.
  assert.notEqual(classify(input({ phases: failedAt('ready', 'Failed to fetch dynamically imported module: https://esm.sh/x') }))?.class, 'infra');
});

test('a dependency version that does not exist is an app bug', () => {
  const f = classify(input({ phases: failedAt('install', 'npm install failed (exit 1): npm error code ETARGET\nnpm error notarget No matching version found for canvas-confetti@^99.0.0.') }));
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'unresolvable-dependency']);
});

test('a render crash in a Next.js page (webpack-internal frames) is an app bug', () => {
  const f = classify(
    input({
      phases: failedAt('ready', "app threw before rendering: Cannot read properties of undefined (reading 'theme')"),
      pageErrors: [{ source: 'app', message: "Cannot read properties of undefined (reading 'theme')", stack: 'TypeError: x\n    at Home (webpack-internal:///(pages-dir-node)/./pages/index.tsx:16:28)\n    at renderWithHooks (file:///app/node_modules/react-dom/cjs/react-dom-server.edge.development.js:3626:20)' }],
    }),
  );
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'app-error-before-ready']);
});

test('a package that does not exist is an app bug; a missing tarball of a listed version is infra', () => {
  const missing = classify(input({ phases: failedAt('install', 'npm install failed (exit 1): npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/left-padd - Not found') }));
  assert.deepEqual([missing?.class, missing?.rule], ['app-bug', 'unresolvable-dependency']);
  const tarball = classify(input({ phases: failedAt('install', 'npm install failed (exit 1): npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/electron-to-chromium/-/electron-to-chromium-1.5.443.tgz - Not found') }));
  assert.equal(tarball?.class, 'infra');
});

test('a Node built-in the runtime lacks (even an underscored one) is a runtime limitation, not an undeclared import', () => {
  const f = classify(input({ phases: failedAt('start', `Error: Cannot find module '_http_client'`) }));
  assert.deepEqual([f?.class, f?.rule], ['runtime-unsupported', 'signature:missing-builtin']);
});

test('a project file Vite cannot compile is an app bug at its location; a dependency is not', () => {
  const stderr = (file: string) => [
    '[runtime:stderr] \x1b[31m5:30:33 PM [vite] Internal server error: /app/src/App.tsx: Unexpected token (2:15)\x1b[39m',
    '[runtime:stderr]   Plugin: vite:react-babel',
    `[runtime:stderr]   File: /app/${file}:2:15`,
    '[runtime:stderr]   1  |  export default function App() {',
  ];
  const f = classify(input({ phases: failedAt('ready', 'app did not render after a console error: 500'), runtimeOutput: stderr('src/App.tsx') }));
  assert.deepEqual([f?.class, f?.rule, f?.message], ['app-bug', 'compile-error', 'src/App.tsx:2:15: Unexpected token (2:15)']);
  const dep = classify(input({ phases: failedAt('ready', 'app did not render after a console error: 500'), runtimeOutput: stderr('node_modules/x/index.js') }));
  assert.notEqual(dep?.rule, 'compile-error');
  // Vite 5: the path starts the message, the location ends it.
  const inline = classify(input({ phases: failedAt('ready', '500'), runtimeOutput: ['[runtime:stderr] 6:21 PM [vite] Pre-transform error: /app/src/App.tsx: Unterminated JSX contents. (2:14)', '[runtime:stderr] '] }));
  assert.equal(inline?.message, 'src/App.tsx:2:14: Unterminated JSX contents. (2:14)');
  // Svelte: path and location first, "File:" below with its color codes.
  const svelte = classify(input({ phases: failedAt('ready', '500'), runtimeOutput: ['[runtime:stderr] [vite] Internal server error: /app/src/lib/Counter.svelte:10:2 Unterminated regular expression', '[runtime:stderr]   File: \x1b[36m/app/src/lib/Counter.svelte\x1b[39m:10:2'] }));
  assert.equal(svelte?.message, 'src/lib/Counter.svelte:10:2: Unterminated regular expression');
  // Vite 8 (oxc): the message on a coded line, the location in a code frame, "File:" without one.
  const oxc = classify(
    input({
      phases: failedAt('ready', '500'),
      runtimeOutput: [
        '[runtime:stderr] 10:18:10 AM [vite] Internal server error: Transform failed with 1 error:',
        '[runtime:stderr] ',
        "[runtime:stderr] [PARSE_ERROR] Unexpected token. Did you mean `{'}'}` or `&rbrace;`?",
        '[runtime:stderr]    \x1b[38;5;246m╭\x1b[0m\x1b[38;5;246m─\x1b[0m\x1b[38;5;246m[\x1b[0m app/src/App.tsx:3:1 \x1b[38;5;246m]\x1b[0m',
        '[runtime:stderr]  3 │ }',
        '[runtime:stderr]   Plugin: vite:oxc',
        '[runtime:stderr]   File: /app/src/App.tsx',
      ],
    }),
  );
  assert.equal(oxc?.message, "src/App.tsx:3:1: Unexpected token. Did you mean `{'}'}` or `&rbrace;`?");
  // The same from a full-stack dev script, each line behind its process's prefix.
  const prefixed = classify(
    input({
      phases: failedAt('ready', '500'),
      runtimeOutput: ['[client] [vite] Internal server error: Transform failed with 1 error:', '[client] [PARSE_ERROR] Unexpected token', '[client]    ╭─[ app/client/src/App.tsx:3:1 ]', '[client]   File: /app/client/src/App.tsx'],
    }),
  );
  assert.equal(prefixed?.message, 'client/src/App.tsx:3:1: Unexpected token');
});

test('ng serve waiting after a failed first build is an app bug at the error\'s location', () => {
  const stderr = [
    "[runtime:stderr] ✘ [ERROR] TS2339: Property 'remainingCount' does not exist on type 'TaskStore'. [plugin angular-compiler]",
    '[runtime:stderr] ',
    '[runtime:stderr]     /app/src/app/tasks/task-list.html:7:26:',
  ];
  const f = classify(input({ phases: [{ name: 'start', status: 'timeout', durationMs: 1, error: { name: 'PhaseTimeout', message: 'start did not finish' } }], runtimeOutput: stderr }));
  assert.deepEqual([f?.class, f?.rule, f?.message], ['app-bug', 'compile-error', "src/app/tasks/task-list.html:7:26: TS2339: Property 'remainingCount' does not exist on type 'TaskStore'."]);
});

test('an undeclared import that Vite reports while the page waits is an undeclared import, not a compile error', () => {
  const f = classify(
    input({
      phases: failedAt('ready', 'ready did not finish', undefined, 'timeout'),
      runtimeOutput: ['[runtime:stderr] \x1b[31m[vite] Internal server error: Failed to resolve import "lodash/debounce" from "src/App.tsx". Does the file exist?\x1b[39m', '[runtime:stderr]   File: /app/src/App.tsx:1:21'],
    }),
  );
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'undeclared-import']);
});

test('an install in the page: a missing package is the app\'s, a registry that fails to answer is not', () => {
  const missing = classify(input({ phases: failedAt('install', 'npm error 404 Not Found - GET https://registry.npmjs.org/nope - Not found', 'APP') }));
  assert.deepEqual([missing?.class, missing?.rule], ['app-bug', 'unresolvable-dependency']);
  const down = classify(input({ phases: failedAt('install', 'npm registry: react: HTTP 503', 'INTERNAL') }));
  assert.equal(down?.class, 'infra');
  const corrupt = classify(input({ phases: failedAt('install', 'npm registry: react@19.3.0: integrity check failed', 'INTERNAL') }));
  assert.equal(corrupt?.class, 'infra');
});

test('a WebAssembly trap on the dev server is the runtime, not the app', () => {
  const f = classify(input({
    phases: failedAt('ready', 'app did not render after a console error: 500'),
    runtimeOutput: ['[runtime:stdout] [client] 7:08:10 AM [vite] Internal server error: memory access out of bounds', '[runtime:stdout] [client]   Plugin: builtin:vite-json'],
  }));
  assert.deepEqual([f?.class, f?.rule], ['runtime-unsupported', 'signature:wasm-trap']);
});

test("a WebAssembly trap the dev server reported to the page (Vite's dependency optimizer, in Angular's dev server) is the runtime's", () => {
  const message = 'app threw before rendering: Error during dependency optimization:\n\nBuild failed with 1 error:\n\nError: memory access out of bounds';
  const f = classify(input({ phases: failedAt('ready', message), pageErrors: [{ source: 'app', message: message.slice('app threw before rendering: '.length) }] }));
  assert.deepEqual([f?.class, f?.rule, f?.message], ['runtime-unsupported', 'signature:wasm-trap', 'app threw before rendering: Error during dependency optimization: Build failed with 1 error: Error: memory access out of bounds']);
});

test("an error the app logged instead of throwing, from its own code, before it rendered: Angular's ErrorHandler, SolidStart", () => {
  const angular = classify(
    input({
      phases: failedAt('ready', "app did not render after a console error: ERROR TypeError: Cannot read properties of undefined (reading 'theme')"),
      pageErrors: [{ source: 'app', message: "ERROR TypeError: Cannot read properties of undefined (reading 'theme')\n    at <instance_members_initializer> (http://s-1.sandburg.localhost:39303/main.js:364:25)\n    at new _App (http://s-1.sandburg.localhost:39303/main.js:366:5)" }],
    }),
  );
  assert.deepEqual([angular?.class, angular?.rule], ['app-bug', 'app-error-before-ready']);
  const solid = classify(
    input({
      phases: failedAt('ready', 'app did not render after a console error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)'),
      pageErrors: [{ source: 'app', message: "TypeError: Cannot read properties of undefined (reading 'theme')\n    at Promise.Home [as resolved] (/app/src/routes/index.tsx?pick=default&pick=$css&lang.tsx:36:28)" }],
    }),
  );
  assert.deepEqual([solid?.class, solid?.rule], ['app-bug', 'app-error-before-ready']);
  // A message without a stack is not one (an error page's 500).
  const plain = classify(input({ phases: failedAt('ready', 'app did not render after a console error: x'), pageErrors: [{ source: 'app', message: 'Failed to load resource: http://s-1.sandburg.localhost/main.js' }] }));
  assert.deepEqual([plain?.class, plain?.rule], ['unknown', 'unmatched']);
});

test("the dev server's report of a page it could not render on the server: Nuxt's request error, Astro's stack through the page", () => {
  const ready = failedAt('ready', 'app did not render after a console error: Failed to load resource: the server responded with a status of 500 (Server Error)');
  const nuxt = classify(
    input({
      phases: ready,
      runtimeOutput: ['[runtime:stdout] ● Rendering GET /', '[runtime:stdout] [request error] [GET] /', "[runtime:stdout]   ✖ TypeError (500): Cannot read properties of undefined (reading 'theme')", '[runtime:stdout]     at setup http://s-1.sandburg.localhost:39303/__sa…f461.mjs:22268:42'],
    }),
  );
  assert.deepEqual([nuxt?.class, nuxt?.rule, nuxt?.message], ['app-bug', 'server-render-error', "TypeError: Cannot read properties of undefined (reading 'theme')"]);
  const syntax = classify(input({ phases: ready, runtimeOutput: ['[runtime:stdout] [request error] [GET] /', '[runtime:stdout]   ✖ SyntaxError [VITE_ERROR] (500): Unexpected token (2:15)'] }));
  assert.deepEqual([syntax?.class, syntax?.rule, syntax?.message], ['app-bug', 'compile-error', 'SyntaxError: Unexpected token (2:15)']);
  const astro = classify(
    input({
      phases: ready,
      runtimeOutput: [
        "[runtime:stderr] 05:43:57 [ERROR] TypeError: Cannot read properties of undefined (reading 'theme')",
        '[runtime:stderr]     at eval (/app/src/pages/index.astro:30:28)',
        '[runtime:stderr]     at index (/app/node_modules/astro/dist/runtime/server/astro-component.js:27:14)',
      ],
    }),
  );
  assert.deepEqual([astro?.class, astro?.rule, astro?.message], ['app-bug', 'server-render-error', "TypeError: Cannot read properties of undefined (reading 'theme')"]);
  // A stack through dependencies only is not the app's.
  const deps = classify(input({ phases: ready, runtimeOutput: ['[runtime:stderr] [ERROR] TypeError: x', '[runtime:stderr]     at index (/app/node_modules/astro/dist/runtime/server/astro-component.js:27:14)'] }));
  assert.deepEqual([deps?.class, deps?.rule], ['unknown', 'unmatched']);
});

test("a WebAssembly trap in the app's own code in the page (sql.js) is the app's", () => {
  const f = classify(
    input({
      phases: failedAt('ready', 'app threw before rendering: RuntimeError: memory access out of bounds'),
      pageErrors: [{ source: 'app', message: 'RuntimeError: memory access out of bounds', stack: 'RuntimeError: memory access out of bounds\n    at wasm://wasm/0012:wasm-function[44]:0x1f0\n    at openDb (http://s-1.sandburg.localhost:39303/src/db.ts:12:7)' }],
    }),
  );
  assert.deepEqual([f?.class, f?.rule], ['app-bug', 'app-error-before-ready']);
});

test('a warning the app logged with a stack (React\'s missing key) is not an error the app threw', () => {
  const f = classify(
    input({
      phases: failedAt('ready', 'app did not render after a console error: Failed to load resource: the server responded with a status of 404 (Not Found) (http://s-1.sandburg.localhost:39303/__sw__/chunk.js)'),
      pageErrors: [{ source: 'app', message: 'Warning: Each child in a list should have a unique "key" prop.\n    at li\n    at List (http://s-1.sandburg.localhost:39303/src/List.tsx:4:3)' }],
    }),
  );
  assert.deepEqual([f?.class, f?.rule], ['unknown', 'unmatched']);
});

test('a console error that names a thrown error counts, however it is introduced; a warning with a component stack does not', () => {
  const ready = failedAt('ready', 'app did not render after a console error: x');
  const stack = '\n    at load (http://s-1.sandburg.localhost:39303/src/App.tsx:8:3)';
  const rule = (message: string) => classify(input({ phases: ready, pageErrors: [{ source: 'app', message: message + stack }] }))?.rule;
  for (const thrown of ['Uncaught (in promise) TypeError: x is not a function', '[nuxt] error caught during app initialization TypeError: x is undefined', "DOMException: Failed to execute 'querySelector'", 'ERROR TypeError: x', 'RangeError: Invalid time value']) {
    assert.equal(rule(thrown), 'app-error-before-ready', thrown);
  }
  for (const warning of ['Warning: Each child in a list should have a unique "key" prop.', 'Each child in a list should have a unique "key" prop.', 'Warning: a TypeError: in a warning is still a warning']) {
    assert.equal(rule(warning), 'unmatched', warning);
  }
  // A path segment named like an error, followed by a colon, is a path.
  for (const path of ['Loaded module src/components/Error: ok', 'Loaded module src\\components\\Error: ok', 'Rendered /app/src/routes/NotFoundException: done', 'Loaded src/AppError:12']) {
    assert.equal(rule(path), 'unmatched', path);
  }
  // A namespaced error is still one.
  assert.equal(rule('Prisma.PrismaClientKnownRequestError: x'), 'app-error-before-ready');
});

test("dependencies and generated code are not the project's: node_modules at any depth, .nuxt, .svelte-kit and the like", () => {
  const ready = failedAt('ready', 'app did not render after a console error: x');
  for (const frame of ['/app/packages/web/node_modules/some-lib/dist/index.js:10:5', '/app/.nuxt/dist/server/server.mjs:120:11', '/app/.svelte-kit/generated/root.js:3:1', '/app/.angular/cache/vite/deps/chunk.js:1:1']) {
    const f = classify(input({ phases: ready, pageErrors: [{ source: 'app', message: `TypeError: x\n    at run (${frame})` }] }));
    assert.deepEqual([f?.class, f?.rule], ['unknown', 'unmatched'], frame);
  }
});

test("only the dev server's report on the app's page, since the ready phase began, is a server render error", () => {
  const ready = failedAt('ready', 'app did not render after a console error: Failed to load resource: the server responded with a status of 500');
  // The app's API, not its page.
  const api = classify(input({ phases: ready, appPath: '/', runtimeOutput: ['[runtime:stdout] [request error] [GET] /api/items', '[runtime:stdout]   ✖ Error (500): db down'] }));
  assert.deepEqual([api?.class, api?.rule], ['unknown', 'unmatched']);
  // A page request with a query is the page.
  const page = classify(input({ phases: ready, appPath: '/', runtimeOutput: ['[runtime:stdout] [request error] [GET] /?x=1', '[runtime:stdout]   ✖ Error (500): db down'] }));
  assert.deepEqual([page?.class, page?.rule], ['app-bug', 'server-render-error']);
  // An error handled before the ready phase began (a seed script, a warm-up) is not the page's.
  const earlier = classify(
    input({ phases: ready, readyOutputFrom: 2, runtimeOutput: ['[runtime:stderr] [ERROR] TypeError: seed failed', '[runtime:stderr]     at seed (/app/server/seed.ts:4:1)', '[runtime:stdout] ready in 300 ms'] }),
  );
  assert.deepEqual([earlier?.class, earlier?.rule], ['unknown', 'unmatched']);
});

test('a project or checks file that did not load is the failure, even with no phase or check recorded', () => {
  const setupError = { rule: 'checks-load', class: 'unknown', message: 'SyntaxError: Unexpected end of input' } as const;
  assert.deepEqual(classify({ probe: null, phases: [], checks: [], pageErrors: [], infraError: null, declaredDependencies: [], setupError }), {
    class: 'unknown',
    phase: 'probe',
    rule: 'checks-load',
    message: 'SyntaxError: Unexpected end of input',
    evidence: [],
  });
});

test("what the source check found is the ready phase's failure when that phase stalled on it or timed out, and only then", () => {
  const syntax = { rule: 'compile-error' as const, file: 'src/components/ConverterFeature.tsx', line: 3, column: 16, message: 'Unexpected ";"' };
  const undeclared = { rule: 'undeclared-import' as const, file: 'src/components/CounterFeature.tsx', line: 3, message: 'dayjs' };
  const stalled = (f: typeof syntax | typeof undeclared) => failedAt('ready', `app did not render, and its sources have an error: ${f.rule === 'compile-error' ? 'src/components/ConverterFeature.tsx:3:16: Unexpected ";"' : 'imports undeclared package "dayjs" (src/components/CounterFeature.tsx:3)'}`);
  const s = classify(input({ phases: stalled(syntax), sourceFindings: [syntax] }));
  assert.deepEqual([s?.class, s?.phase, s?.rule, s?.message], ['app-bug', 'ready', 'compile-error', 'src/components/ConverterFeature.tsx:3:16: Unexpected ";"']);
  const u = classify(input({ phases: stalled(undeclared), sourceFindings: [undeclared] }));
  assert.deepEqual([u?.class, u?.rule, u?.message], ['app-bug', 'undeclared-import', 'imports undeclared package "dayjs" (src/components/CounterFeature.tsx:3)']);
  // The ready phase timed out with the dev server never quiet for long enough: the same.
  const timedOut = classify(input({ phases: failedAt('ready', 'ready timed out after 240000 ms', undefined, 'timeout'), sourceFindings: [syntax] }));
  assert.deepEqual([timedOut?.class, timedOut?.rule], ['app-bug', 'compile-error']);
  // The ready phase failed for a reason of its own (the app threw), or another phase failed: not the source check's.
  const threw = classify(input({ phases: failedAt('ready', 'app threw before rendering: x'), sourceFindings: [syntax] }));
  assert.deepEqual([threw?.class, threw?.rule], ['unknown', 'unmatched']);
  const start = classify(input({ phases: failedAt('start', 'start timed out', undefined, 'timeout'), sourceFindings: [syntax] }));
  assert.deepEqual([start?.class, start?.rule], ['timeout', 'phase-deadline']);
  // Sandburg's own failure (a tab that crashed, an offline cache miss, a download that broke) is
  // classified as it is without the source check's findings, whether the phase timed out or failed.
  for (const phases of [failedAt('ready', 'ready timed out after 240000 ms', undefined, 'timeout'), failedAt('ready', 'app did not render, and its sources have an error: x')]) {
    for (const infra of [{ infraError: { phase: 'ready' as const, message: 'the tab crashed' } }, { runtimeErrors: ['npm registry: socket hang up'] }]) {
      const without = classify(input({ phases, ...infra }));
      const withFindings = classify(input({ phases, ...infra, sourceFindings: [syntax] }));
      assert.notEqual(withFindings?.class, 'app-bug');
      assert.deepEqual([withFindings?.class, withFindings?.rule], [without?.class, without?.rule]);
    }
  }
});
