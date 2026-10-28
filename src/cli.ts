import { parseArgs, type ParseArgsConfig } from 'node:util';
import { stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Session, type RunOptions, type SessionOptions } from './orchestrator/session.ts';
import { defaultParallel, discoverProjects, runBatch } from './orchestrator/batch.ts';
import { BrowserSetupError, NO_SANDBOX } from './orchestrator/launch.ts';
import { writeAppFiles } from './orchestrator/app-files.ts';
import { loadProject } from './project.ts';
import { adapterNames } from './adapters.ts';
import { loadChecks } from './orchestrator/checks.ts';
import { loadPageChecks } from './page-checks/index.ts';
import { SnapshotStore } from './store.ts';
import type { FileTree, RunResult } from './types.ts';

const USAGE = `Usage: sandburg <command> [options]

Commands:
  run <project>        Run one project and check it
  batch <dir>          Run every project in <dir> (subdirectories, .zip or .json), N tabs at a time
  open <project>       Load a project in a visible browser tab and keep it open
  snapshot <project>   Store a project in the snapshot store and print its id
  compare <dir>        Run projects in the browser and in a Docker reference; report agreement

<project> is a directory, a .zip, a JSON file tree, or snapshot:<id-or-prefix>.

Options:
  --runtime <name>     node (default; the only runtime)
  --install-in <where> host (default: npm on the host) or browser (opt-in: the page installs
                       from the npm registry itself)
  --checks <file>      Checks file; default export maps check names to functions
                       (batch: a project's own checks.spec.ts takes precedence)
  --checks-in <where>  host (default: the checks file is imported here) or page (its code runs in
                       the sandbox tab, with Playwright-shaped locators and expect)
  --parallel <n>       batch/compare: tabs at a time (default: one per core, up to 8)
  --no-prewarm         batch/compare: do not warm up common stacks first (only runs when their
                       installs are missing)
  --no-longest-first   batch: start the projects in the order found, not those that took longest
                       in earlier batches first (for timings to compare between batches)
  --out <dir>          Results directory (default: .sandburg/runs)
  --cache <dir>        HTTP cache directory (default: .sandburg/cache)
  --store <dir>        Snapshot store directory (default: .sandburg/store)
  --offline            Serve only from the cache; never fetch upstream
  --ready <selector>   Wait for this selector before running checks
  --save-files <regex> run: after the checks, write the app's files whose path matches <regex>
                       (its SQLite database, say) back into the project directory. The pattern
                       decides what is written: anchor it, e.g. '\\.db$'
  --headed             Show the browser window
  --no-browser-sandbox Run Chromium without its OS sandbox (default: sandboxed; also
                       SANDBURG_NO_BROWSER_SANDBOX=1). Only for hosts where the sandbox cannot
                       start (as root, or user namespaces restricted); results record it
  --browser-sandbox    Run it sandboxed even where SANDBURG_NO_BROWSER_SANDBOX=1 is set
  --json               Print full JSON instead of a summary
  --reference <name>   compare: the reference runtime (docker, the default and only one)
  --report <path>      compare: write the report to <path>.md and <path>.json
                       (default: .sandburg/reports/fidelity)
  -h, --help           Show this help

Exit codes: 0 passed, 1 failed (app ran, a blocking check failed), 2 error (run did not reach checks,
or they did not finish in time, or its project or checks file did not load), 64 usage error. compare: 0
once it has its report, 2 when nothing could be compared (the reference judged no app, or every run of
one side ended in error).`;

const OPTIONS = {
  runtime: { type: 'string', default: 'node' },
  'install-in': { type: 'string', default: 'host' },
  checks: { type: 'string' },
  'checks-in': { type: 'string', default: 'host' },
  parallel: { type: 'string', default: String(defaultParallel()) },
  prewarm: { type: 'boolean', default: true },
  'longest-first': { type: 'boolean', default: true },
  out: { type: 'string' },
  cache: { type: 'string' },
  store: { type: 'string' },
  offline: { type: 'boolean', default: false },
  ready: { type: 'string' },
  'save-files': { type: 'string' },
  headed: { type: 'boolean', default: false },
  // No default: unset leaves it to SessionOptions' (on, unless $SANDBURG_NO_BROWSER_SANDBOX is 1).
  'browser-sandbox': { type: 'boolean' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  // compare
  reference: { type: 'string', default: 'docker' },
  report: { type: 'string' },
} satisfies ParseArgsConfig['options'];

/** The command line, parsed (throws on an unknown or malformed option). */
export function parseCommandLine(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, allowNegative: true, options: OPTIONS });
}

/** The session options a command's options ask for. */
export function sessionOptions(values: ReturnType<typeof parseCommandLine>['values'], command: string): SessionOptions {
  return {
    cacheDir: values.cache,
    storeDir: values.store,
    offline: values.offline,
    headless: !values.headed && command !== 'open',
    browserSandbox: values['browser-sandbox'],
  };
}

const COMMANDS = ['run', 'batch', 'open', 'snapshot', 'compare'];

/** A project, checks file or directory named on the command line that did not load (exit code 2). */
class InputError extends Error {}

/** `what` loaded, or an InputError with its first line. */
async function input<T>(what: Promise<T>): Promise<T> {
  try {
    return await what;
  } catch (err) {
    throw new InputError((err instanceof Error ? err.message : String(err)).split('\n')[0]);
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await command(argv);
  } catch (err) {
    // What to change on this host, without Playwright's launch log (the error's cause).
    if (!(err instanceof BrowserSetupError) && !(err instanceof InputError)) throw err;
    console.error(`error: ${err.message}`);
    return 2;
  }
}

async function command(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCommandLine(argv);
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
  if (!COMMANDS.includes(command)) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 64;
  }
  if (!target) {
    console.error(`${command}: missing argument\n\n${USAGE}`);
    return 64;
  }
  const options = sessionOptions(values, command);
  if (values['install-in'] !== 'host' && values['install-in'] !== 'browser') {
    console.error('--install-in must be host or browser');
    return 64;
  }
  if (values['checks-in'] !== 'host' && values['checks-in'] !== 'page') {
    console.error('--checks-in must be host or page');
    return 64;
  }
  if (!adapterNames.includes(values.runtime)) {
    console.error(`--runtime must be ${adapterNames.join(' or ')}`);
    return 64;
  }
  const parallel = Number.parseInt(values.parallel, 10);
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error('--parallel must be a positive integer');
    return 64;
  }
  // What run and open name is loaded before the browser starts: a path that is not there fails here.
  // A batch's --checks loads in each run that has no checks of its own (a checks-load error there).
  const checksFile = values.checks;
  const checks =
    checksFile === undefined || (command !== 'run' && command !== 'open') ? checksFile : await input<RunOptions['checks']>(values['checks-in'] === 'page' ? loadPageChecks(checksFile) : loadChecks(checksFile));
  const runOptions: RunOptions = {
    runtime: values.runtime,
    installIn: values['install-in'],
    checks,
    checksIn: values['checks-in'],
    outDir: values.out,
    readySelector: values.ready,
  };
  const store = new SnapshotStore(resolve(values.store ?? '.sandburg/store'));

  switch (command) {
    case 'snapshot': {
      const project = await input(loadProject(target, store));
      console.log(await store.put(project.files, project.name));
      return 0;
    }
    case 'run':
    case 'open': {
      const save = values['save-files'];
      if (save !== undefined) {
        if (command !== 'run' || !(await stat(target).then((s) => s.isDirectory(), () => false))) {
          console.error('--save-files: only for run, with a project directory');
          return 64;
        }
        try {
          new RegExp(save);
        } catch (err) {
          console.error(`--save-files: ${(err as Error).message}`);
          return 64;
        }
      }
      const project = await input(loadProject(target, store));
      let saved: FileTree | null = null;
      let refused: string | undefined;
      const result = await withSession(options, (s) =>
        s.run(project, {
          ...runOptions,
          hold: command === 'open',
          ...(save !== undefined && { collectFiles: save, onAppFiles: (files: FileTree, why?: string) => ((saved = files), (refused = why)) }),
        }),
      );
      if (refused) console.error(`--save-files: nothing written: ${refused}`);
      else if (saved) {
        const skipped = await writeAppFiles(resolve(target), saved);
        if (skipped.length) console.error(`--save-files: not written: ${skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
      }
      const dir = relative(process.cwd(), join(values.out ?? '.sandburg/runs', result.runId));
      console.log(values.json ? JSON.stringify(result, null, 2) : summarize(result, dir));
      return exitCode(result.status);
    }
    case 'batch': {
      const items = await input(discoverProjects(target));
      if (items.length === 0) {
        console.error(`no projects in ${target}`);
        return 64;
      }
      const { summary } = await withSession(options, (s) =>
        runBatch(s, items, {
          ...runOptions,
          parallel,
          prewarm: values.prewarm,
          longestFirst: values['longest-first'],
          log: (line) => console.error(line),
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
      if (values.reference !== 'docker') {
        console.error(`unknown reference "${values.reference}" (available: docker)`);
        return 64;
      }
      const items = await input(discoverProjects(target));
      if (!items.length) {
        console.error(`no projects in ${target}`);
        return 64;
      }
      return compareCommand(items, { ...values, parallel }, options, runOptions);
    }
    default:
      throw new Error(`no case for command ${command}`);
  }
}

async function withSession<T>(options: SessionOptions, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = new Session(options);
  await session.open();
  if (!session.browserSandbox) console.error(`warning: ${NO_SANDBOX}`);
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
    const mark = c.status === 'passed' ? 'ok  ' : c.status === 'skipped' ? 'skip' : c.blocking ? 'FAIL' : 'warn';
    lines.push(`  ${mark} ${c.name}${c.message ? ` — ${c.message.split('\n')[0]}` : ''}`);
  }
  if (!r.environment.browserSandbox) lines.push(`  browser  ${NO_SANDBOX}`);
  if (r.failure) lines.push(`  failure  ${r.failure.class} in ${r.failure.phase} [${r.failure.rule}]: ${r.failure.message.split('\n')[0]}`);
  lines.push(`  result   ${join(dir, 'result.json')}`);
  return lines.join('\n');
}
