/**
 * Where a run's time goes in the browser: runs a project once to warm it, then again under Chromium's
 * tracing with V8's sampling CPU profiler, and prints, for each busy thread (the runtime's worker,
 * its threads, the page), self time by package (node_modules/<name>), by Sandburg's own runtime,
 * WebAssembly and GC; then the runtime's own functions by self time.
 *
 *   node scripts/profile.ts <project> [--checks file] [--trace out.json] [--top 15]
 *
 * See ADR 0017 for what it found.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright-core';
import { Session } from '../src/index.ts';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { checks: { type: 'string' }, trace: { type: 'string' }, top: { type: 'string', default: '15' } } });
const project = positionals[0];
if (!project) {
  console.error('usage: node scripts/profile.ts <project> [--checks file] [--trace out.json] [--top n]');
  process.exit(64);
}
const top = Number(args.top);

const session = new Session();
await session.open();
const browser = (session as unknown as { browser: Browser }).browser;
await session.run(project, { checks: args.checks });
await browser.startTracing(undefined, { categories: ['v8', 'disabled-by-default-v8.cpu_profiler'] });
const result = await session.run(project, { checks: args.checks });
const trace = await browser.stopTracing();
await session.close();
if (args.trace) await writeFile(args.trace, trace);
console.log(`${result.status}: ${result.phases.map((p) => `${p.name} ${(p.durationMs / 1000).toFixed(1)} s`).join(', ')}\n`);

interface Node {
  id: number;
  parent?: number;
  callFrame: { functionName: string; url?: string; lineNumber?: number };
}
const events = JSON.parse(trace.toString('utf8')) as { traceEvents: { name: string; pid?: number; id?: string; args?: { data?: { cpuProfile?: { nodes?: Node[]; samples?: number[] }; timeDeltas?: number[] } } }[] };
interface Profile {
  nodes: Map<number, Node>;
  samples: number[];
  deltas: number[];
}
const profiles = new Map<string, Profile>();
for (const e of events.traceEvents) {
  if (e.name !== 'ProfileChunk' || !e.id) continue;
  // Profile ids are per process: the same id in two processes is two profiles.
  const key = `${e.pid}:${e.id}`;
  const p: Profile = profiles.get(key) ?? { nodes: new Map(), samples: [], deltas: [] };
  profiles.set(key, p);
  const data = e.args?.data;
  for (const n of data?.cpuProfile?.nodes ?? []) p.nodes.set(n.id, n);
  p.samples.push(...(data?.cpuProfile?.samples ?? []));
  p.deltas.push(...(data?.timeDeltas ?? []));
}

/** What a sample's code belongs to: a package, Sandburg's runtime, WebAssembly, the project, or V8's own. */
function category(cf: Node['callFrame']): string {
  const url = cf.url ?? '';
  if (!url) return cf.functionName.startsWith('(') ? cf.functionName : '(no url: native or evaluated)';
  if (url.startsWith('wasm://') || url.endsWith('.wasm')) return 'WebAssembly';
  if (url.includes('/__sandburg/node-worker.js')) return 'Sandburg runtime';
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
  if (pkg) return pkg[1] === 'next' && url.includes('/compiled/webpack/') ? 'next (webpack)' : pkg[1];
  if (url.startsWith('/app/')) return 'project';
  return new URL(url, 'http://x').pathname.split('/').slice(0, 3).join('/');
}

const fmt = (ms: number) => `${ms.toFixed(0).padStart(7)} ms`;
for (const p of [...profiles.values()].sort((a, b) => b.samples.length - a.samples.length)) {
  const byCategory = new Map<string, number>();
  const runtime = new Map<string, number>();
  let busy = 0;
  p.samples.forEach((id, i) => {
    const node = p.nodes.get(id);
    if (!node) return;
    const ms = (p.deltas[i] ?? 0) / 1000;
    const cat = category(node.callFrame);
    if (cat === '(idle)') return;
    busy += ms;
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + ms);
    if (cat === 'Sandburg runtime') {
      const fn = `${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber}`;
      runtime.set(fn, (runtime.get(fn) ?? 0) + ms);
    }
  });
  if (busy < 300) continue;
  console.log(`Thread busy ${fmt(busy).trim()}`);
  for (const [cat, ms] of [...byCategory].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${fmt(ms)}  ${cat}`);
  if (runtime.size) {
    console.log('  Sandburg runtime, by function (line in /__sandburg/node-worker.js):');
    for (const [fn, ms] of [...runtime].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`    ${fmt(ms)}  ${fn}`);
  }
  console.log();
}
