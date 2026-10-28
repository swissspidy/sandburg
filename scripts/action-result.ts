/**
 * The GitHub Action's last step (action.yml): reads what `sandburg run --json` printed, sets the
 * action's outputs (status, result-path) and writes the run's checks to the job summary.
 *
 *   node scripts/action-result.ts <stdout file> <sandburg's exit code>
 *
 * It runs from the action's own ref, where nothing is installed: Node's built-ins only.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../src/types.ts';

/** The result in what `run --json` printed: the whole of it, or from its first line that opens an object. */
export function parseResult(text: string): RunResult | null {
  for (const start of [0, text.search(/^\{/m)]) {
    if (start < 0) continue;
    try {
      const value = JSON.parse(text.slice(start)) as RunResult;
      if (value && typeof value === 'object' && typeof value.runId === 'string') return value;
    } catch {
      // Not JSON from there.
    }
  }
  return null;
}

/** The job summary's Markdown for a run (or for a run that printed no result). */
export function summary(result: RunResult | null, exitCode: number): string {
  if (!result) return `### Sandburg: error\n\n\`sandburg run\` exited ${exitCode} without a result; its log is above.\n`;
  const lines = [`### Sandburg: ${result.status}`, '', `${result.project.name} (${result.project.framework}), ${(result.timings.totalMs / 1000).toFixed(1)} s`, ''];
  if (result.failure) lines.push(`**${result.failure.class}** in ${result.failure.phase} (\`${result.failure.rule}\`): ${oneLine(result.failure.message)}`, '');
  lines.push('| Check | Status | Blocking |', '|---|---|---|');
  for (const c of result.checks) lines.push(`| ${oneLine(c.name)} | ${c.status}${c.message ? `: ${oneLine(c.message)}` : ''} | ${c.blocking ? 'yes' : 'no'} |`);
  return lines.join('\n') + '\n';
}

const oneLine = (text: string) => text.split('\n')[0].replaceAll('|', '\\|').slice(0, 300);

function main([file, code]: string[]): void {
  const exitCode = Number(code);
  const result = parseResult(readFileSync(file, 'utf8'));
  const resultPath = result ? join('.sandburg/runs', result.runId, 'result.json') : '';
  const status = result?.status ?? 'error';
  console.log(result ? `sandburg: ${status} (${resultPath})` : `sandburg: no result (exit code ${exitCode})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\nresult-path=${resultPath}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result, exitCode));
}

if (import.meta.main) main(process.argv.slice(2));
