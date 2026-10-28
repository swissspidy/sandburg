import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Session, type RunOptions, type SessionOptions } from '../orchestrator/session.ts';
import type { BatchItem } from '../orchestrator/batch.ts';
import { NO_SANDBOX } from '../orchestrator/launch.ts';
import { dockerReference, type DockerReferenceFactory } from '../reference/docker.ts';
import { compare, type CompareReport } from './compare.ts';
import { renderReport } from './report.ts';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * `sandburg compare`: runs `items` in the browser and in the Docker reference and writes the report
 * (exit code: compareExitCode). `reference` is for tests (a fake docker CLI): the CLI's is dockerReference().
 */
export async function compareCommand(
  items: BatchItem[],
  values: { report?: string; json?: boolean; parallel: number; prewarm?: boolean; [k: string]: unknown },
  sessionOptions: SessionOptions,
  runOptions: RunOptions,
  reference: DockerReferenceFactory = dockerReference(),
): Promise<number> {
  const session = new Session(sessionOptions);
  await session.open();
  if (!session.browserSandbox) console.error(`warning: ${NO_SANDBOX}`);
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
    const code = compareExitCode(report);
    if (code) console.error('error: nothing to compare (the reference judged no app, or every run of one side ended in error: before its checks, or with checks that did not finish in time)');
    return code;
  } finally {
    release();
    await session.close();
  }
}

/**
 * 0 once a comparison has its report, whatever the apps did; 2 when nothing could be compared: no
 * pair was comparable (the reference judged no app), or every run of one side ended in error, before
 * its checks or with checks that did not finish in time (a broken environment, not a finding).
 */
export function compareExitCode(report: Pick<CompareReport, 'overall' | 'pairs'>): number {
  const ranAny = (side: 'browser' | 'reference') => report.pairs.some((p) => p[side].status !== 'error');
  return report.overall.n > 0 && ranAny('browser') && ranAny('reference') ? 0 : 2;
}
