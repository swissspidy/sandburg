import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { cycleChanges, cycles, DOC, environments, ENVIRONMENTS, type Graph, importGraph, KNOWN_CYCLES, updatedDoc, violations } from '../../scripts/architecture.ts';

// The architecture's rules (docs/architecture.md, scripts/architecture.ts) over src/'s import graph.
const graph = importGraph();

test('no import breaks a layer or an environment rule', () => {
  assert.deepEqual(violations(graph), []);
});

test('no new import cycle, and every known one still exists', () => {
  const { added, removed } = cycleChanges(graph);
  assert.deepEqual(added, [], 'a new import cycle: break it (a module both sides import), see docs/architecture.md');
  assert.deepEqual(removed, [], 'a known cycle is gone: remove it from KNOWN_CYCLES in scripts/architecture.ts');
});

test('every module runs in an environment, or is imported only for its types', () => {
  for (const { entries } of Object.values(ENVIRONMENTS)) for (const e of entries) assert.ok(existsSync(e), `${e} is an entry, but not there`);
  const where = environments(graph);
  const valueImported = new Set(graph.imports.filter((i) => !i.typeOnly).map((i) => i.to));
  const unplaced = graph.modules.filter((m) => !where.has(m) && valueImported.has(m));
  assert.deepEqual(unplaced, [], 'imported by value, but reached from no entry: add its bundle\'s entry to ENVIRONMENTS');
});

test("the entries are the bundles' own: the host page and each adapter's browser half, its assets, the compile worker, the page checks", async () => {
  const { relative } = await import('node:path');
  const { adapterNames, getAdapter } = await import('../../src/adapters.ts');
  const { COMPILE_WORKER } = await import('../../src/adapters/node/compile-wasm-bundle.ts');
  const rel = (p: string) => relative(process.cwd(), p);
  const adapters = adapterNames.map(getAdapter);
  assert.deepEqual(ENVIRONMENTS.page.entries, ['src/host/host.ts', ...adapters.map((a) => rel(a.browserEntry))]);
  assert.deepEqual(ENVIRONMENTS['service-worker'].entries, adapters.flatMap((a) => Object.values(a.assets).map(rel)));
  assert.deepEqual(ENVIRONMENTS['compile-worker'].entries, [rel(COMPILE_WORKER)]);
  // The page checks' runtime (page-checks/index.ts bundles it) and the runtime's script (bundle.ts).
  for (const [env, file, entry] of [['app-frame', 'src/page-checks/index.ts', 'page-checks/runtime.ts'], ['runtime', 'src/node-runtime/bundle.ts', "here('worker.ts')"]] as const) {
    assert.ok(readFileSync(file, 'utf8').includes(entry), `${file} no longer bundles ${entry}`);
    assert.ok(ENVIRONMENTS[env].entries.some((e) => e.endsWith(entry.replace(/^here\('(.*)'\)$/, '$1'))), env);
  }
});

test("the lint config's browser-only rule covers every module that runs in a browser", () => {
  // .oxlintrc.json refuses node:* imports in browser code, for the editor and `npm run lint`; its
  // file list is kept true here.
  const config = JSON.parse(readFileSync('.oxlintrc.json', 'utf8')) as { overrides: { files: string[]; rules: Record<string, unknown> }[] };
  const isBrowserRule = (rule: unknown) => (JSON.stringify(rule) ?? '').includes('"node:*"');
  const on = config.overrides.filter((o) => isBrowserRule(o.rules['eslint/no-restricted-imports'])).flatMap((o) => o.files);
  const off = config.overrides.filter((o) => o.rules['eslint/no-restricted-imports'] === 'off').flatMap((o) => o.files);
  const covered = (m: string) => on.some((g) => matchesGlob(m, g)) && !off.some((g) => matchesGlob(m, g));
  const where = environments(graph);
  const stubbed = new Set(graph.imports.filter((i) => [...(where.get(i.from) ?? [])].some((e) => ENVIRONMENTS[e].stubs?.includes(i.to))).map((i) => i.from));
  const inBrowser = graph.modules.filter((m) => [...(where.get(m) ?? [])].some((e) => e !== 'host') && !stubbed.has(m));
  assert.deepEqual(inBrowser.filter((m) => !covered(m)), [], 'runs in a browser: add it to the browser-only override in .oxlintrc.json');
  const listed = on.filter((g) => !g.includes('*'));
  assert.deepEqual(listed.filter((m) => !inBrowser.includes(m)), [], 'listed as browser code in .oxlintrc.json, but runs on the host only');
});

test('docs/architecture.md has the current layers and environments', () => {
  assert.equal(readFileSync(DOC, 'utf8'), updatedDoc(), 'the layers or environments changed: run node scripts/architecture.ts --update and commit docs/architecture.md');
});

// The rules catch what they are for (a graph made up for the purpose).
const made = (imports: [from: string, to: string, typeOnly?: boolean][]): Graph => {
  const modules = [...new Set(imports.flatMap(([from, to]) => [from, to]).filter((m) => m.startsWith('src/')))].sort();
  return { modules, imports: imports.map(([from, to, typeOnly = false]) => ({ from, to, typeOnly, dynamic: false, line: 1 })) };
};

test('the rules refuse a node:* or host-only import in browser code, a lower layer importing a higher one, and the orchestrator reaching past the registry', () => {
  const found = violations(
    made([
      ['src/node-runtime/worker.ts', 'src/node-runtime/vfs.ts'],
      ['src/node-runtime/vfs.ts', 'node:fs'],
      ['src/node-runtime/vfs.ts', 'src/orchestrator/limits.ts'],
      ['src/host/host.ts', 'esbuild'],
      ['src/orchestrator/session.ts', 'src/adapters/node/index.ts'],
      ['src/types.ts', 'src/orchestrator/session.ts', true],
      // Allowed: a type import of a host module from browser code, and the compile worker's stubs.
      ['src/adapters/node/browser.ts', 'src/node-runtime/messages.ts', true],
      ['src/adapters/node/compile-worker.ts', 'src/adapters/node/compile.ts'],
      ['src/adapters/node/compile.ts', 'node:crypto'],
      ['src/orchestrator/session.ts', 'src/adapters.ts'],
    ]),
  );
  assert.equal(found.length, 5, found.join('\n'));
  assert.match(found[0], /vfs\.ts:1: imports node:fs, but runs in the browser \(runtime\)/);
  assert.match(found[1], /node-runtime imports orchestrator/);
  assert.match(found[2], /host\.ts:1: imports esbuild, a host-only package/);
  assert.match(found[3], /orchestrator imports adapters \(src\/adapters\/node\/index\.ts\)/);
  assert.match(found[4], /core imports orchestrator/);
});

test('a cycle of value imports is found; type imports and dynamic imports make none', () => {
  const g = made([
    ['src/a.ts', 'src/b.ts'],
    ['src/b.ts', 'src/c.ts'],
    ['src/c.ts', 'src/a.ts'],
    ['src/d.ts', 'src/e.ts'],
    ['src/e.ts', 'src/d.ts', true],
  ]);
  g.imports.push({ from: 'src/e.ts', to: 'src/d.ts', typeOnly: false, dynamic: true, line: 2 });
  assert.deepEqual(cycles(g), [['src/a.ts', 'src/b.ts', 'src/c.ts']]);
  assert.ok(KNOWN_CYCLES.every((c) => c.length > 1));
});
