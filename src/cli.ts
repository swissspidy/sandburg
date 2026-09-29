import { parseArgs, type ParseArgsConfig } from 'node:util';
import { join, relative, resolve } from 'node:path';
import { Session, type RunOptions, type SessionOptions } from './orchestrator/session.ts';
import { discoverProjects, runBatch } from './orchestrator/batch.ts';
import { loadProject } from './project.ts';
import { SnapshotStore } from './store.ts';
import type { RunResult } from './types.ts';

const USAGE = `Usage: sandburg <command> [options]

Commands:
  run <project>        Run one project and check it
  batch <dir>          Run every project in <dir> (subdirectories or .json trees), N tabs at a time
  open <project>       Load a project in a visible browser tab and keep it open
  snapshot <project>   Store a project in the snapshot store and print its id
  compare <dir>        Run projects in the browser and in a Docker reference; report agreement

<project> is a directory, a JSON file tree, or snapshot:<id-or-prefix>.

Options:
  --runtime <name>     Runtime adapter (default: almostnode)
  --checks <file>      Checks file; default export maps check names to functions
                       (batch: a project's own checks.spec.ts takes precedence)
  --parallel <n>       batch/compare: tabs at a time (default: 4)
  --out <dir>          Results directory (default: .sandburg/runs)
  --cache <dir>        HTTP cache directory (default: .sandburg/cache)
  --store <dir>        Snapshot store directory (default: .sandburg/store)
  --offline            Serve only from the cache; never fetch upstream
  --ready <selector>   Wait for this selector before running checks
  --headed             Show the browser window
  --json               Print full JSON instead of a summary
  -h, --help           Show this help

Exit codes: 0 passed, 1 failed (app ran, a blocking check failed), 2 error (run did not reach checks), 64 usage error.`;

const OPTIONS = {
  runtime: { type: 'string', default: 'almostnode' },
  checks: { type: 'string' },
  parallel: { type: 'string', default: '4' },
  out: { type: 'string' },
  cache: { type: 'string' },
  store: { type: 'string' },
  offline: { type: 'boolean', default: false },
  ready: { type: 'string' },
  headed: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  // compare
  reference: { type: 'string', default: 'docker' },
  corpus: { type: 'string' },
  report: { type: 'string' },
} satisfies ParseArgsConfig['options'];

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 64;
  }
  const { values, positionals } = parsed;
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 64;
  }
  if (!target) {
    console.error(`${command}: missing argument\n\n${USAGE}`);
    return 64;
  }
  const sessionOptions: SessionOptions = {
    cacheDir: values.cache,
    storeDir: values.store,
    offline: values.offline,
    headless: !values.headed && command !== 'open',
  };
  const runOptions: RunOptions = {
    runtime: values.runtime,
    checks: values.checks,
    outDir: values.out,
    readySelector: values.ready,
  };
  const parallel = Number.parseInt(values.parallel, 10);
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error('--parallel must be a positive integer');
    return 64;
  }

  switch (command) {
    case 'snapshot': {
      const store = new SnapshotStore(resolve(values.store ?? '.sandburg/store'));
      const project = await loadProject(target, store);
      console.log(await store.put(project.files, project.name));
      return 0;
    }
    case 'run':
    case 'open': {
      const result = await withSession(sessionOptions, (s) =>
        s.run(target, { ...runOptions, hold: command === 'open' }),
      );
      const dir = relative(process.cwd(), join(values.out ?? '.sandburg/runs', result.runId));
      console.log(values.json ? JSON.stringify(result, null, 2) : summarize(result, dir));
      return exitCode(result.status);
    }
    case 'batch': {
      const items = await discoverProjects(target);
      if (items.length === 0) {
        console.error(`no projects in ${target}`);
        return 64;
      }
      const { summary } = await withSession(sessionOptions, (s) =>
        runBatch(s, items, {
          ...runOptions,
          parallel,
          onResult: (r, item) => {
            if (!values.json) console.log(`${r.status.padEnd(6)} ${(r.timings.totalMs / 1000).toFixed(1).padStart(6)}s  ${item.label}${r.failure ? `  [${r.failure.class}: ${r.failure.rule}]` : ''}`);
          },
        }),
      );
      if (values.json) console.log(JSON.stringify(summary, null, 2));
      else {
        const t = summary.totals;
        console.log(
          `\n${t.runs} runs in ${(summary.wallMs / 1000).toFixed(1)}s (parallel ${summary.parallel}, speed-up ${summary.speedup}x): ` +
            `${t.passed} passed, ${t.failed} failed, ${t.error} error; cache ${t.cacheHits} hit / ${t.cacheMisses} miss; ${t.blockedRequests} blocked\n` +
            `summary: ${relative(process.cwd(), resolve('.sandburg/batches', summary.batchId, 'summary.json'))}`,
        );
      }
      return summary.totals.error ? 2 : summary.totals.failed ? 1 : 0;
    }
    case 'compare': {
      const { compareCommand } = await import('./compare/cli.ts');
      return compareCommand(target, { ...values, parallel }, sessionOptions, runOptions);
    }
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 64;
  }
}

async function withSession<T>(options: SessionOptions, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = new Session(options);
  await session.open();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

function exitCode(status: RunResult['status']): number {
  return status === 'passed' ? 0 : status === 'failed' ? 1 : 2;
}

function summarize(r: RunResult, dir: string): string {
  const t = r.timings;
  const fmt = (v: number | null) => (v === null ? '-' : `${(v / 1000).toFixed(2)}s`);
  const lines = [
    `${r.status.toUpperCase()}  ${r.project.name} (${r.project.framework}) on ${r.runtime.name} ${r.runtime.version}`,
    `  snapshot ${r.project.snapshotId.slice(0, 12)}`,
    `  timings  load ${fmt(t.loadMs)}  mount ${fmt(t.mountMs)}  install ${fmt(t.installMs)}  start ${fmt(t.startMs)}  ready ${fmt(t.readyMs)}  checks ${fmt(t.checksMs)}  total ${fmt(t.totalMs)}`,
    `  network  ${r.network.requests} requests, cache ${r.network.cacheHits} hit / ${r.network.cacheMisses} miss, ${r.network.blocked.length} blocked, ${r.network.failed.length} failed`,
  ];
  for (const c of r.checks) {
    const mark = c.status === 'passed' ? 'ok  ' : c.blocking ? 'FAIL' : 'warn';
    lines.push(`  ${mark} ${c.name}${c.message ? ` — ${c.message.split('\n')[0]}` : ''}`);
  }
  if (r.failure) lines.push(`  failure  ${r.failure.class} in ${r.failure.phase} [${r.failure.rule}]: ${r.failure.message.split('\n')[0]}`);
  lines.push(`  result   ${join(dir, 'result.json')}`);
  return lines.join('\n');
}
