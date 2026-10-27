import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Session, type RunOptions, type SessionOptions } from '../orchestrator/session.ts';
import type { BatchItem } from '../orchestrator/batch.ts';
import { NO_SANDBOX } from '../orchestrator/launch.ts';
import { dockerReference } from '../reference/docker.ts';
import { compare, type CompareReport } from './compare.ts';
import { renderReport } from './report.ts';

/** `sandburg compare`: runs `items` in the browser and in the Docker reference and writes the report (exit code: compareExitCode). */
export async function compareCommand(
  items: BatchItem[],
  values: { report?: string; json?: boolean; parallel: number; prewarm?: boolean; [k: string]: unknown },
  sessionOptions: SessionOptions,
  runOptions: RunOptions,
): Promise<number> {
  const session = new Session(sessionOptions);
  await session.open();
  if (!session.browserSandbox) console.error(`warning: ${NO_SANDBOX}`);
  try {
    const report = await compare(session, items, {
      ...runOptions,
      reference: { name: 'docker', factory: dockerReference() },
      parallel: values.parallel,
      prewarm: values.prewarm,
      log: (line: string) => console.error(line),
      referenceParallel: Math.min(values.parallel, 3),
      onResult: (side, r, item) =>
        console.error(`${side.padEnd(9)} ${r.status.padEnd(6)} ${(r.timings.totalMs / 1000).toFixed(1).padStart(6)}s  ${item.label}${r.failure ? `  [${r.failure.class}: ${r.failure.rule}]` : ''}`),
    });
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
