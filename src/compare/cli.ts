import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Session, type RunOptions, type SessionOptions } from '../orchestrator/session.ts';
import { discoverProjects } from '../orchestrator/batch.ts';
import { NO_SANDBOX } from '../orchestrator/launch.ts';
import { dockerReference } from '../reference/docker.ts';
import { compare } from './compare.ts';
import { renderReport } from './report.ts';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export async function compareCommand(
  target: string,
  values: { reference?: string; report?: string; json?: boolean; parallel: number; prewarm?: boolean; [k: string]: unknown },
  sessionOptions: SessionOptions,
  runOptions: RunOptions,
): Promise<number> {
  if (values.reference !== 'docker') {
    console.error(`unknown reference "${values.reference}" (available: docker)`);
    return 64;
  }
  const items = await discoverProjects(target);
  if (!items.length) {
    console.error(`no projects in ${target}`);
    return 64;
  }
  const session = new Session(sessionOptions);
  await session.open();
  if (!session.browserSandbox) console.error(`warning: ${NO_SANDBOX}`);
  const reference = dockerReference();
  // Ctrl-C (or a kill) removes the reference's containers and project copies and closes the browser,
  // then exits 130 (143 for SIGTERM). Playwright's own handlers (close the browser, exit at once) wait
  // meanwhile: a second Ctrl-C gets them.
  const held = SIGNALS.map((signal) => [signal, process.listeners(signal)] as const);
  let released = false;
  /** Set once a signal came: it exits the process, and the runs it cut short are not reported. */
  const stop: { exiting: Promise<never> | null } = { exiting: null };
  const release = () => {
    if (released) return;
    released = true;
    for (const [signal, listeners] of held) {
      process.off(signal, interrupted);
      for (const l of listeners) process.on(signal, l);
    }
  };
  const interrupted = (signal: NodeJS.Signals) => {
    release();
    console.error(`${signal}: removing the reference's containers`);
    const exit = () => process.exit(signal === 'SIGTERM' ? 143 : 130);
    stop.exiting = reference.disposeAll().then(() => session.close()).then(exit, exit);
  };
  for (const [signal, listeners] of held) {
    for (const l of listeners) process.off(signal, l);
    process.on(signal, interrupted);
  }
  try {
    const report = await compare(session, items, {
      ...runOptions,
      reference: { name: 'docker', factory: reference },
      parallel: values.parallel,
      prewarm: values.prewarm,
      log: (line: string) => console.error(line),
      referenceParallel: Math.min(values.parallel, 3),
      onResult: (side, r, item) => {
        if (!stop.exiting) console.error(`${side.padEnd(9)} ${r.status.padEnd(6)} ${(r.timings.totalMs / 1000).toFixed(1).padStart(6)}s  ${item.label}${r.failure ? `  [${r.failure.class}: ${r.failure.rule}]` : ''}`);
      },
    }).catch((err: unknown) => {
      // Runs cut short by a signal may fail the batch: the signal's exit is the outcome.
      if (stop.exiting) return stop.exiting;
      throw err;
    });
    if (stop.exiting) return await stop.exiting;
    const base = resolve(values.report ?? '.sandburg/reports/fidelity');
    await mkdir(dirname(base), { recursive: true });
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
    await writeFile(`${base}.md`, renderReport(report));
    console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
    console.error(`report: ${base}.md, ${base}.json`);
    return 0;
  } finally {
    release();
    await session.close();
  }
}
