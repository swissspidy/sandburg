import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Session, type RunOptions, type SessionOptions } from '../orchestrator/session.ts';
import { discoverProjects } from '../orchestrator/batch.ts';
import { dockerReference } from '../reference/docker.ts';
import { compare } from './compare.ts';
import { renderReport } from './report.ts';

export async function compareCommand(
  target: string,
  values: { reference?: string; report?: string; json?: boolean; parallel: number; [k: string]: unknown },
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
  try {
    const report = await compare(session, items, {
      ...runOptions,
      reference: { name: 'docker', factory: dockerReference() },
      parallel: values.parallel,
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
    return 0;
  } finally {
    await session.close();
  }
}
