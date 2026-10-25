/**
 * esbuild's transforms on the host's native esbuild (ADR NNNN), tried from a sandbox's side: the host
 * answers only transforms (no plugins, no files), only for esbuild versions whose output its own
 * matches, within its bounds (size, transforms in progress per sandbox and in all, time), and only to
 * the sandbox's own pages; its answers are the WebAssembly build's.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { createNativeTransform, NATIVE_MAX_BYTES, nativeOptions, nativeVersion } from '../../src/node-runtime/native-transform.ts';
import { nativeTransform } from '../../src/adapters/node/native-transform.ts';
import { HostServer } from '../../src/orchestrator/host-server.ts';
import { WASM_BUILDS } from '../../src/adapters/node/install-rules.ts';
import type { AdapterDescriptor, HostRequest } from '../../src/types.ts';

const TSX = 'import { useState } from "react";\nexport function App(): JSX.Element { const [n, setN] = useState<number>(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }\n';
const OPTIONS = { loader: 'tsx', jsx: 'automatic', target: 'esnext', sourcemap: true, sourcefile: '/app/src/App.tsx', tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } } };

function req(body: string, { v = esbuild.version, method = 'POST', sandbox = 'one' } = {}): HostRequest {
  return {
    method,
    path: '/__sandburg/esbuild-transform',
    query: new URLSearchParams({ v }),
    sandbox,
    body: async (max) => {
      const b = Buffer.from(body);
      if (max !== undefined && b.length > max) throw new Error('413');
      return b;
    },
  };
}

test('the host answers for esbuild 0.25 up to its own version, and nothing else', () => {
  for (const v of ['0.25.0', '0.25.12', '0.27.3', esbuild.version]) assert.ok(nativeVersion(v, esbuild.version), v);
  const [major, minor, patch] = esbuild.version.split('.').map(Number);
  for (const v of ['0.24.2', '0.18.20', `${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, '1.0.0', '0.25', '0.25.0-beta.1', '', undefined, 25]) assert.ok(!nativeVersion(v, esbuild.version), String(v));
});

test("only a transform's own options, with plain values, go to the host", () => {
  assert.ok(nativeOptions(undefined));
  assert.ok(nativeOptions(OPTIONS));
  assert.ok(nativeOptions({ ...OPTIONS, define: { 'process.env.X': '"1"' }, supported: { bigint: true }, minify: undefined }));
  // Vite's: its own JSX option leaves the tsconfig's out.
  assert.ok(nativeOptions({ ...OPTIONS, tsconfigRaw: { compilerOptions: { jsx: undefined, target: 'ES2022' } } }));
  for (const options of [
    { mangleProps: /^_/ }, // a regular expression
    { mangleProps: {} }, // not a transform option the host passes on
    { plugins: [] },
    { absWorkingDir: '/' },
    { tsconfig: '/etc/passwd' }, // a build option
    { write: true },
    { logLevel: 'verbose' },
    { logLevel: 'debug' },
    { define: { x: () => 1 } },
    { banner: new Uint8Array(1) },
    { lineLimit: Infinity },
    { pure: ['a', undefined] }, // JSON makes it null
    Object.create({ loader: 'ts' }),
    [],
    null,
    'loader=ts',
  ]) assert.ok(!nativeOptions(options), JSON.stringify(options) ?? String(options));
});

test("the host's answer is the WebAssembly build's", async () => {
  const res = await nativeTransform(req(JSON.stringify([OPTIONS, TSX])));
  assert.equal(res.status, 200);
  const native = JSON.parse(String(res.body)) as esbuild.TransformResult;
  // esbuild-wasm at the host's version, as a program in the runtime has it.
  const dir = dirname(createRequire(import.meta.url).resolve('esbuild-wasm/package.json'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, esbuild.version);
  const wasm = createRequire(import.meta.url)(join(dir, 'lib/main.js')) as typeof esbuild;
  const expected = await wasm.transform(TSX, OPTIONS as esbuild.TransformOptions);
  await wasm.stop();
  assert.deepEqual({ code: native.code, map: native.map, warnings: native.warnings }, { code: expected.code, map: expected.map, warnings: expected.warnings });
});

test('a request the host does not answer is refused, and the runtime transforms it itself', async () => {
  const status = async (r: HostRequest) => (await nativeTransform(r)).status;
  assert.equal(await status(req(JSON.stringify([OPTIONS, TSX]), { method: 'GET' })), 405);
  assert.equal(await status(req(JSON.stringify([OPTIONS, TSX]), { v: '0.24.0' })), 422);
  assert.equal(await status(req(JSON.stringify([{ ...OPTIONS, plugins: [] }, TSX]))), 422);
  assert.equal(await status(req(JSON.stringify([{ tsconfig: 'tsconfig.json' }, TSX]))), 422);
  assert.equal(await status(req(JSON.stringify([OPTIONS, { code: TSX }]))), 422);
  assert.equal(await status(req('{"not": "json"')), 400);
  // Code with errors: the app's own esbuild reports them, as its version does.
  assert.equal(await status(req(JSON.stringify([OPTIONS, 'export const = 1;']))), 422);
  // Larger than the bound.
  assert.notEqual(await status(req(JSON.stringify([{}, 'x'.repeat(NATIVE_MAX_BYTES)]))), 200);
  // Nothing an app asks for is printed on the host.
  let logged: unknown;
  await nativeTransform(req(JSON.stringify([{ logLevel: 'error' }, 'let x = 1 +;'])), (input, options) => ((logged = options?.logLevel), esbuild.transform(input, options)));
  assert.equal(logged, 'silent');
});

test('answers are kept by a digest of the request and the esbuild version', async () => {
  let calls = 0;
  const counted: typeof esbuild.transform = (input, options) => (calls++, esbuild.transform(input, options));
  const body = JSON.stringify([{ ...OPTIONS, sourcefile: '/app/src/Kept.tsx' }, TSX]);
  const first = await nativeTransform(req(body), counted);
  const second = await nativeTransform(req(body, { sandbox: 'two' }), counted);
  assert.equal(calls, 1);
  assert.equal(second.body, first.body);
  // Any other byte is another request.
  await nativeTransform(req(JSON.stringify([{ ...OPTIONS, sourcefile: '/app/src/Kept.tsx' }, `${TSX} `])), counted);
  assert.equal(calls, 2);
});

test('a sandbox has at most 4 transforms in progress, and the host 16', async () => {
  const waiting: (() => void)[] = [];
  const slow: typeof esbuild.transform = (input, options) => new Promise<void>((r) => waiting.push(r)).then(() => esbuild.transform(input, options));
  const ask = (sandbox: string, i: number) => nativeTransform(req(JSON.stringify([{ sourcefile: `/${sandbox}/${i}.ts` }, `export const n = ${i};`]), { sandbox }), slow);
  const first = [0, 1, 2, 3].map((i) => ask('greedy', i));
  await new Promise((r) => setImmediate(r));
  assert.equal((await ask('greedy', 4)).status, 503);
  // Another sandbox is still answered, up to the host's bound.
  const others = Array.from({ length: 12 }, (_, i) => ask(`other${i}`, i));
  await new Promise((r) => setImmediate(r));
  assert.equal((await ask('late', 0)).status, 503);
  while (waiting.length < 16) await new Promise((r) => setImmediate(r));
  for (const go of waiting) go();
  for (const res of await Promise.all([...first, ...others])) assert.equal(res.status, 200);
  // The slots are free again.
  assert.equal((await nativeTransform(req(JSON.stringify([{}, 'export const again = 1;']), { sandbox: 'greedy' }))).status, 200);
});

test('a transform that takes too long is answered 503, and holds its slot until it is done', async () => {
  let finish!: () => void;
  const stuck: typeof esbuild.transform = (input, options) => new Promise<void>((r) => (finish = r)).then(() => esbuild.transform(input, options));
  const res = await nativeTransform(req(JSON.stringify([{}, 'export const stuck = 1;']), { sandbox: 'stuck' }), stuck, 50);
  assert.equal(res.status, 503);
  const others = [1, 2, 3].map((i) => nativeTransform(req(JSON.stringify([{}, `export const s${i} = 1;`]), { sandbox: 'stuck' }), (i2, o) => new Promise((r) => setTimeout(r, 20)).then(() => esbuild.transform(i2, o))));
  await new Promise((r) => setImmediate(r));
  assert.equal((await nativeTransform(req(JSON.stringify([{}, 'export const s4 = 1;']), { sandbox: 'stuck' }))).status, 503);
  finish();
  await Promise.all(others);
});

test("the runtime's hook asks only for eligible transforms and falls back on any other answer", async () => {
  const asked: string[] = [];
  const reply = (status: number, body: unknown): typeof fetch => async (url) => (asked.push(String(url)), new Response(JSON.stringify(body), { status }));
  const ok = { code: 'export const n = 1;\n', map: '', warnings: [] };
  const pendingWork = { count: 0 };
  const hook = (f: typeof fetch, post?: (url: string, body: Uint8Array) => Promise<{ status: number; body: Uint8Array } | null> | null) => createNativeTransform({ base: '/__sandburg', hostVersion: esbuild.version, fetch: f, post, pending: pendingWork });
  assert.equal(hook(reply(200, ok))('0.24.2', 'x', {}), null);
  assert.equal(hook(reply(200, ok))(esbuild.version, new Uint8Array(1), {}), null);
  assert.equal(hook(reply(200, ok))(esbuild.version, 'x', { mangleProps: /x/ }), null);
  assert.equal(hook(reply(200, ok))(esbuild.version, 'x', new Proxy({}, { getPrototypeOf() { throw new Error('no'); } })), null);
  assert.equal(asked.length, 0);
  assert.deepEqual(await hook(reply(200, ok))('0.25.12', 'x', { loader: 'ts' }), ok);
  assert.equal(asked[0], '/__sandburg/esbuild-transform?v=0.25.12');
  assert.equal(await hook(reply(503, 'busy'))(esbuild.version, 'x', {}), null);
  assert.equal(await hook(reply(200, { nope: 1 }))(esbuild.version, 'x', {}), null);
  assert.equal(await hook(async () => { throw new TypeError('offline'); })(esbuild.version, 'x', {}), null);
  // Warnings the app's log level would print: its own esbuild prints them.
  const warned = { ...ok, warnings: [{ id: '', pluginName: '', text: 'w', location: null, notes: [] }] };
  assert.equal(await hook(reply(200, warned))(esbuild.version, 'x', { logLevel: 'warning' }), null);
  const silent = await hook(reply(200, warned))(esbuild.version, 'x', {});
  assert.ok(silent && 'detail' in silent.warnings[0]);
  // Over the file channel when it answers; over HTTP when it does not.
  asked.length = 0;
  const posted: string[] = [];
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  assert.deepEqual(await hook(reply(200, ok), (url) => (posted.push(url), Promise.resolve({ status: 200, body: bytes(ok) })))(esbuild.version, 'x', {}), ok);
  assert.equal(await hook(reply(200, ok), () => Promise.resolve({ status: 422, body: bytes('no') }))(esbuild.version, 'x', {}), null);
  assert.deepEqual(await hook(reply(200, ok), () => Promise.resolve(null))(esbuild.version, 'x', {}), ok);
  assert.deepEqual(await hook(reply(200, ok), () => null)(esbuild.version, 'x', {}), ok);
  assert.deepEqual([posted.length, asked.length], [1, 2]);
  assert.equal(pendingWork.count, 0);
});

// --- through the host server ------------------------------------------------------------------

let host: HostServer;
let origin: string;
before(async () => {
  host = new HostServer();
  await host.listen();
  const adapter: AdapterDescriptor = { name: 'node', version: '0', browserEntry: '', assets: {}, egress: [], crossOriginIsolation: false, probe: () => ({ verdict: 'supported' }), serve: (r) => nativeTransform(r) };
  origin = host.register('one', adapter);
});
after(() => host.close());

function post(headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: host.port, path: `/__sandburg/esbuild-transform?v=${esbuild.version}`, method: 'POST', headers: { host: new URL(origin).host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    r.on('error', reject);
    r.end(body);
  });
}

test("only the sandbox's own pages reach the route", async () => {
  const body = JSON.stringify([OPTIONS, TSX]);
  assert.equal(await post({ 'sec-fetch-site': 'same-origin' }, body), 200);
  // Another sandbox's page (same site: *.sandburg.localhost) and another site.
  for (const site of ['same-site', 'cross-site']) assert.equal(await post({ 'sec-fetch-site': site }, body), 403, site);
});

// --- the esbuild shim -------------------------------------------------------------------------

test("the esbuild shim asks the runtime's hook first, and its own esbuild for anything the hook does not answer", async () => {
  // An install's esbuild as the shim makes it: lib/main.js, with esbuild-wasm (the host's version) beside it.
  const root = mkdtempSync(join(tmpdir(), 'sandburg-esbuild-shim-'));
  const pkg = join(root, 'node_modules', 'esbuild');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  mkdirSync(join(pkg, 'node_modules'));
  symlinkSync(dirname(createRequire(import.meta.url).resolve('esbuild-wasm/package.json')), join(pkg, 'node_modules', 'esbuild-wasm'));
  writeFileSync(join(pkg, 'lib', 'main.js'), WASM_BUILDS.find((b) => b.name === 'esbuild')!.shim);
  const asked: unknown[][] = [];
  let answer: (input: string) => Promise<unknown> | null = () => null;
  const hook = Symbol.for('sandburg.esbuildTransform');
  Object.defineProperty(globalThis, hook, { configurable: true, value: (...args: unknown[]) => (asked.push(args), answer(args[1] as string)) });
  try {
    const shim = createRequire(import.meta.url)(join(pkg, 'lib', 'main.js')) as typeof esbuild;
    answer = () => Promise.resolve({ code: 'from the host', map: '', warnings: [] });
    assert.equal((await shim.transform('let a: number = 1', { loader: 'ts' })).code, 'from the host');
    assert.deepEqual(asked[0], [esbuild.version, 'let a: number = 1', { loader: 'ts' }]);
    // Not sent (null), or no answer (a null result): the shim's own esbuild transforms it.
    for (const reply of [() => null, () => Promise.resolve(null)]) {
      answer = reply;
      assert.equal((await shim.transform('let b: number = 2', { loader: 'ts' })).code, 'let b = 2;\n');
    }
    // Its own errors, as its version reports them.
    answer = () => Promise.resolve(null);
    await assert.rejects(shim.transform('let = ;', { loader: 'ts' }), /Transform failed with 1 error/);
    // Builds are its own.
    const built = await shim.build({ stdin: { contents: 'export const n: number = 1', loader: 'ts' }, write: false });
    assert.match(built.outputFiles[0].text, /const n = 1/);
    assert.equal(asked.length, 4);
    await shim.stop();
  } finally {
    Reflect.deleteProperty(globalThis, hook);
    rmSync(root, { recursive: true, force: true });
  }
});
