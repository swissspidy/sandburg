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
  const f = classify(input({ phases: failedAt('mount', 'Failed to fetch dynamically imported module: https://playground.wordpress.net/assets/index-BG9JLHps.js') }));
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
