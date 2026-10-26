/**
 * The architecture's rules, as data and checks over src/'s import graph (docs/architecture.md):
 *
 * - **Environments**: where a module runs. Each bundle Sandburg builds or serves has entry points;
 *   a module runs wherever a value import (static, dynamic or require) reaches it from an entry.
 *   Code that runs in a browser (the host page, a runtime's worker, the compile worker, the service
 *   worker, an app's frame) imports nothing of Node's (`node:*`) and no host-only package, except
 *   what its bundle stubs.
 * - **Layers**: what a directory may import (type imports too). The orchestrator reaches the
 *   adapters through their registry (src/adapters.ts) only; the runtime imports no host code.
 * - **Cycles**: value imports form no cycle, except the ones listed in KNOWN_CYCLES (to remove).
 *
 * test/unit/architecture.test.ts fails on a violation, on a browser file the lint config's
 * browser-only override does not cover, and when docs/architecture.md's tables are stale.
 *
 *   node scripts/architecture.ts            # print each module's layer and environments, and any violation
 *   node scripts/architecture.ts --update   # rewrite the layers' and environments' tables in docs/architecture.md
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = join(ROOT, 'docs/architecture.md');

/** One import of a module: `to` is a repo-relative path for a relative specifier, else the specifier. */
export interface Import {
  from: string;
  to: string;
  /** Erased at compile time: `import type` or `export type` (not `import { type A }`, which stays a side-effect import). */
  typeOnly: boolean;
  dynamic: boolean;
  line: number;
}

export interface Graph {
  /** src/'s modules, repo-relative, sorted. */
  modules: string[];
  imports: Import[];
}

type Node = { type: string; start: number; end: number; [k: string]: unknown };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const p = join(dir, name);
      if (name === 'node_modules') return [];
      if (statSync(p).isDirectory()) return sourceFiles(p);
      return /\.(ts|js|cjs|mjs)$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
    })
    .sort();
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as Node;
  if (typeof n.type === 'string') visit(n);
  for (const key in n) if (key !== 'parent') walk(n[key], visit);
}

/** The imports of src/'s modules (or of `dir`'s), from their syntax trees. */
export function importGraph(dir = join(ROOT, 'src')): Graph {
  const files = sourceFiles(dir);
  const imports: Import[] = [];
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    const from = relative(ROOT, file);
    const lineAt = (offset: number) => code.slice(0, offset).split('\n').length;
    const add = (specifier: string, typeOnly: boolean, dynamic: boolean, offset: number) => {
      const to = specifier.startsWith('.') ? relative(ROOT, resolve(dirname(file), specifier)) : specifier;
      imports.push({ from, to, typeOnly, dynamic, line: lineAt(offset) });
    };
    const r = parseSync(file, code);
    // Erased only as a whole statement (`import type`, `export type`): under verbatimModuleSyntax,
    // `import { type A } from` stays as an import of the module (for its side effects).
    for (const n of r.program.body as unknown as Node[]) {
      if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) {
        add((n.source as Node).value as string, (n.importKind ?? n.exportKind) === 'type', false, n.start);
      }
    }
    walk(r.program, (n) => {
      const literal = (arg: unknown) => {
        const a = arg as Node | undefined;
        return a && (a.type === 'Literal' || a.type === 'StringLiteral') && typeof a.value === 'string' ? a.value : null;
      };
      if (n.type === 'ImportExpression') {
        const spec = literal(n.source);
        if (spec) add(spec, false, true, n.start);
      } else if (n.type === 'CallExpression' && (n.callee as Node).type === 'Identifier' && (n.callee as Node).name === 'require') {
        const spec = literal((n.arguments as unknown[])[0]);
        if (spec) add(spec, false, false, n.start);
      }
    });
  }
  return { modules: files.map((f) => relative(ROOT, f)), imports };
}

export type Environment = 'host' | 'page' | 'runtime' | 'compile-worker' | 'service-worker' | 'app-frame';

/**
 * Where code runs, and the entry points of what runs there. The browser bundles are built by
 * host-server.ts (the page: host.ts with the adapter's browserEntry), node-runtime/bundle.ts (the
 * runtime, with its injected shims and the polyfills' aliases), compile-wasm-bundle.ts (the compile
 * worker) and page-checks/index.ts (the checks' runtime); the service worker and the WebSocket shim
 * are served as they are.
 */
export const ENVIRONMENTS: Record<Environment, { what: string; entries: string[]; stubs?: string[] }> = {
  host: { what: 'Node.js: the session, the host server, installs, compiles, caches', entries: ['src/index.ts', 'src/cli.ts'] },
  page: { what: 'the host page in a sandbox tab (one per run): the adapter\'s browser half', entries: ['src/host/host.ts', 'src/adapters/node/browser.ts'] },
  runtime: {
    what: "a Node.js runtime's Web Worker (and its threads and child processes)",
    entries: ['src/node-runtime/worker.ts', 'src/node-runtime/globals-shim.ts', 'src/node-runtime/lib-globals.js', 'src/node-runtime/process-alias.cjs', 'src/node-runtime/url-querystring.cjs'],
  },
  'compile-worker': { what: "the page's compiler on esbuild-wasm", entries: ['src/adapters/node/compile-worker.ts'], stubs: ['node:crypto', 'esbuild'] },
  'service-worker': { what: "the sandbox origin's service worker", entries: ['src/adapters/node/sw.js'] },
  'app-frame': { what: "the app's frame: the page checks' runtime and the WebSocket shim", entries: ['src/page-checks/runtime.ts', 'src/page-checks/dom-shim.ts', 'src/adapters/node/ws-shim.js'] },
};

/** Packages that only run on the host (Node's APIs, npm's internals): a browser bundle that imports one fails to build or to run. */
const HOST_ONLY_PACKAGES = /^(esbuild|playwright-core|@playwright\/test|oxc-parser|pacote|@npmcli\/arborist|cacache|npm-registry-fetch|npm-package-arg)(\/|$)/;

/**
 * The layers, by path (the first that matches), and the layers each may import. A layer may import
 * its own modules; nothing imports `api`.
 */
export const LAYERS: { name: string; paths: string[]; what: string; imports: string[] }[] = [
  { name: 'api', paths: ['src/index.ts', 'src/cli.ts'], what: 'the package\'s exports and the CLI', imports: ['compare', 'reference', 'orchestrator', 'adapters-registry', 'page-checks', 'core'] },
  { name: 'compare', paths: ['src/compare/'], what: 'comparisons with the Docker reference', imports: ['reference', 'orchestrator', 'core'] },
  { name: 'reference', paths: ['src/reference/'], what: 'the Docker reference runtime', imports: ['orchestrator', 'adapters', 'host', 'core'] },
  { name: 'orchestrator', paths: ['src/orchestrator/'], what: 'the session, Chromium, the host server, egress, checks', imports: ['adapters-registry', 'page-checks', 'host', 'core'] },
  { name: 'adapters-registry', paths: ['src/adapters.ts'], what: 'the adapters by name', imports: ['adapters', 'core'] },
  { name: 'adapters', paths: ['src/adapters/'], what: "an adapter's host and browser halves (the node adapter)", imports: ['host', 'node-runtime', 'core'] },
  { name: 'page-checks', paths: ['src/page-checks/'], what: 'the checks API, its compiler and its in-frame runtime', imports: ['core'] },
  { name: 'host', paths: ['src/host/'], what: 'the host page (RPC from the orchestrator, the adapter\'s browser half)', imports: ['core'] },
  { name: 'node-runtime', paths: ['src/node-runtime/'], what: 'the runtime, and the host-side code that bundles it', imports: ['core'] },
  { name: 'core', paths: ['src/'], what: 'types and helpers every layer shares', imports: [] },
];

export function layerOf(path: string): string {
  return LAYERS.find((l) => l.paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p)))?.name ?? 'outside src';
}

/**
 * Value-import cycles among src/'s modules that are known and not yet removed. The test fails on a
 * new cycle, and on one listed here that no longer exists (then delete it here).
 */
export const KNOWN_CYCLES: string[][] = [
  // worker.ts keeps the runtime's state (its vfs, process, thread, caches) as module bindings that
  // the modules split from it (ADR 0047) import back. Moving that state into a module of its own
  // removes the cycle; worker.ts is edited by several branches a round.
  ['src/node-runtime/builtins.ts', 'src/node-runtime/host-files.ts', 'src/node-runtime/peers.ts', 'src/node-runtime/worker.ts'],
];

/** Which environments each module runs in (value imports from the entries). */
export function environments(graph: Graph): Map<string, Set<Environment>> {
  const edges = valueEdges(graph);
  const where = new Map<string, Set<Environment>>();
  for (const [env, { entries }] of Object.entries(ENVIRONMENTS) as [Environment, { entries: string[] }][]) {
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length) {
      const m = queue.pop()!;
      if (seen.has(m)) continue;
      seen.add(m);
      queue.push(...(edges.get(m) ?? []));
    }
    for (const m of seen) {
      if (!where.has(m)) where.set(m, new Set());
      where.get(m)!.add(env);
    }
  }
  return where;
}

function valueEdges(graph: Graph, withDynamic = true): Map<string, string[]> {
  const modules = new Set(graph.modules);
  const edges = new Map<string, string[]>();
  for (const i of graph.imports) {
    if (i.typeOnly || !modules.has(i.to) || (i.dynamic && !withDynamic)) continue;
    if (!edges.has(i.from)) edges.set(i.from, []);
    edges.get(i.from)!.push(i.to);
  }
  return edges;
}

/** The value-import cycles (static imports: a dynamic import does not run at evaluation), each sorted. */
export function cycles(graph: Graph): string[][] {
  const edges = valueEdges(graph, false);
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) found.push(scc.sort());
    }
  };
  for (const m of graph.modules) if (!index.has(m)) visit(m);
  return found.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Every import that breaks a rule, as `file:line: why`. */
export function violations(graph: Graph): string[] {
  const out: string[] = [];
  const modules = new Set(graph.modules);
  const where = environments(graph);
  for (const i of graph.imports) {
    const at = `${i.from}:${i.line}`;
    // Environments: browser code imports nothing of Node's (type imports are erased).
    const envs = [...(where.get(i.from) ?? [])].filter((e) => e !== 'host');
    if (!i.typeOnly && envs.length) {
      const stubbed = (e: Environment) => ENVIRONMENTS[e].stubs?.includes(i.to);
      const bad = envs.filter((e) => !stubbed(e));
      if (bad.length && i.to.startsWith('node:')) out.push(`${at}: imports ${i.to}, but runs in the browser (${bad.join(', ')})`);
      else if (bad.length && HOST_ONLY_PACKAGES.test(i.to)) out.push(`${at}: imports ${i.to}, a host-only package, but runs in the browser (${bad.join(', ')})`);
    }
    // Layers.
    if (modules.has(i.to)) {
      const from = layerOf(i.from);
      const to = layerOf(i.to);
      const allowed = LAYERS.find((l) => l.name === from)?.imports ?? [];
      if (from !== to && !allowed.includes(to)) out.push(`${at}: ${from} imports ${to} (${i.to}); ${from} may import ${allowed.join(', ') || 'only its own modules'}`);
    }
  }
  return out;
}

/** The new cycles, and the known ones that no longer exist. */
export function cycleChanges(graph: Graph): { added: string[][]; removed: string[][] } {
  const now = cycles(graph);
  const key = (c: string[]) => c.join(' ');
  const known = new Set(KNOWN_CYCLES.map(key));
  const current = new Set(now.map(key));
  return { added: now.filter((c) => !known.has(key(c))), removed: KNOWN_CYCLES.filter((c) => !current.has(key(c))) };
}

const BEGIN = '<!-- architecture:begin (generated by node scripts/architecture.ts --update) -->';
const END = '<!-- architecture:end -->';

/** The generated part of docs/architecture.md: the layers and the environments. */
export function renderMap(): string {
  const lines = [BEGIN, '', '| layer | paths | what | may import |', '| --- | --- | --- | --- |'];
  for (const l of LAYERS) lines.push(`| ${l.name} | ${l.paths.map((p) => `\`${p}\``).join(', ')} | ${l.what} | ${l.imports.join(', ') || '—'} |`);
  lines.push('', '| environment | entries | what |', '| --- | --- | --- |');
  for (const [env, e] of Object.entries(ENVIRONMENTS)) lines.push(`| ${env} | ${e.entries.map((p) => `\`${p.replace(/^src\//, '')}\``).join(', ')} | ${e.what}${e.stubs ? ` (stubs ${e.stubs.map((s) => `\`${s}\``).join(', ')})` : ''} |`);
  lines.push('', END);
  return lines.join('\n');
}

/** Each module, its layer and where it runs (printed by the script; not in the doc, which would change with every new file). */
export function renderModules(graph: Graph): string {
  const where = environments(graph);
  const lines = ['| module | layer | runs in |', '| --- | --- | --- |'];
  for (const m of graph.modules) lines.push(`| \`${m.replace(/^src\//, '')}\` | ${layerOf(m)} | ${[...(where.get(m) ?? [])].join(', ') || 'types only'} |`);
  return lines.join('\n');
}

/** docs/architecture.md with its generated part replaced by the current map. */
export function updatedDoc(doc = readFileSync(DOC, 'utf8')): string {
  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (begin < 0 || end < begin) throw new Error(`${relative(ROOT, DOC)} has no generated part (${BEGIN} … ${END})`);
  return doc.slice(0, begin) + renderMap() + doc.slice(end + END.length);
}

if (import.meta.main) {
  const graph = importGraph();
  if (process.argv.includes('--update')) {
    writeFileSync(DOC, updatedDoc());
    console.log(`wrote ${relative(ROOT, DOC)}`);
  } else console.log(renderModules(graph));
  const problems = violations(graph);
  const { added, removed } = cycleChanges(graph);
  for (const p of problems) console.error(p);
  for (const c of added) console.error(`new import cycle: ${c.join(' → ')}`);
  for (const c of removed) console.error(`a known cycle no longer exists (remove it from KNOWN_CYCLES): ${c.join(' ')}`);
  if (problems.length || added.length || removed.length) process.exitCode = 1;
}
