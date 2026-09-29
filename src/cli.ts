import { parseArgs } from 'node:util';
import { join, relative } from 'node:path';
import { runProject } from './orchestrator/session.ts';
import type { RunResult } from './types.ts';

const USAGE = `Usage: sandburg run <project> [options]

Runs a web project in an in-browser runtime and checks it in the same browser.

Options:
  --runtime <name>     Runtime adapter (default: almostnode)
  --checks <file>      Checks file; default export maps check names to functions
  --out <dir>          Results directory (default: .sandburg/runs)
  --cache <dir>        HTTP cache directory (default: .sandburg/cache)
  --offline            Serve only from the cache; never fetch upstream
  --ready <selector>   Wait for this selector before running checks
  --headed             Show the browser window
  --json               Print the full result JSON instead of a summary
  -h, --help           Show this help

Exit codes: 0 passed, 1 failed (app ran, a blocking check failed), 2 error (run did not reach checks), 64 usage error.`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        runtime: { type: 'string', default: 'almostnode' },
        checks: { type: 'string' },
        out: { type: 'string' },
        cache: { type: 'string' },
        offline: { type: 'boolean', default: false },
        ready: { type: 'string' },
        headed: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 64;
  }
  const { values, positionals } = parsed;
  const [command, project] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 64;
  }
  if (command !== 'run' || !project) {
    console.error(command === 'run' ? 'missing <project>' : `unknown command "${command}" (batch and compare are planned)`);
    return 64;
  }

  const result = await runProject(project, {
    runtime: values.runtime,
    checks: values.checks,
    outDir: values.out,
    cacheDir: values.cache,
    offline: values.offline,
    readySelector: values.ready,
    headless: !values.headed,
  });
  const dir = relative(process.cwd(), join(values.out ?? '.sandburg/runs', result.runId));
  console.log(values.json ? JSON.stringify(result, null, 2) : summarize(result, dir));
  return result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}

function summarize(r: RunResult, dir: string): string {
  const t = r.timings;
  const fmt = (v: number | null) => (v === null ? '-' : `${(v / 1000).toFixed(2)}s`);
  const lines = [
    `${r.status.toUpperCase()}  ${r.project.name} (${r.project.framework}) on ${r.runtime.name} ${r.runtime.version}`,
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
