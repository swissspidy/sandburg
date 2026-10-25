/**
 * A node:test reporter that reports how long each test file and its slowest tests took, and warns
 * when a file takes longer than its budget in test/budgets.json, so that a suite that gets slower
 * shows in CI before it reaches the job's timeout. Use it beside another reporter:
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/test-times.ts --test-reporter-destination=stdout test/e2e/run.test.ts
 *
 * It prints a table, appends it to $GITHUB_STEP_SUMMARY when that is set, and prints a GitHub
 * warning annotation for each file over budget (a warning, not a failure: hosted runners are
 * noisy). A file's time is from its first test's start to its last test's end (hooks included).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

interface TestEvent {
  type: string;
  data: { name: string; nesting: number; file?: string; details?: { duration_ms?: number; type?: string } };
}

const SLOWEST = 10;

function budgets(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(new URL('../test/budgets.json', import.meta.url), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export default async function* testTimes(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const files = new Map<string, { start: number; end: number; tests: number; failed: number }>();
  const tests: { file: string; name: string; ms: number; failed: boolean }[] = [];
  for await (const event of source) {
    const file = event.data.file ? relative(process.cwd(), event.data.file) : null;
    if (!file || event.data.nesting !== 0) continue;
    const now = performance.now();
    let entry = files.get(file);
    if (event.type === 'test:dequeue' || event.type === 'test:start') {
      if (!entry) files.set(file, (entry = { start: now, end: now, tests: 0, failed: 0 }));
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      if (!entry) files.set(file, (entry = { start: now - (event.data.details?.duration_ms ?? 0), end: now, tests: 0, failed: 0 }));
      entry.end = now;
      if (event.data.details?.type === 'suite') continue;
      entry.tests++;
      if (event.type === 'test:fail') entry.failed++;
      tests.push({ file, name: event.data.name, ms: event.data.details?.duration_ms ?? 0, failed: event.type === 'test:fail' });
    }
  }
  const limits = budgets();
  const rows: string[] = [];
  const warnings: string[] = [];
  for (const [file, f] of [...files].sort((a, b) => b[1].end - b[1].start - (a[1].end - a[1].start))) {
    const ms = f.end - f.start;
    const suite = file.replace(/^test\//, '').replace(/\.test\.ts$/, '');
    const budget = limits[suite];
    const over = budget !== undefined && ms > budget * 1000;
    rows.push(`| ${suite} | ${seconds(ms)} | ${budget === undefined ? '' : `${budget} s`}${over ? ' ⚠️ over' : ''} | ${f.tests} | ${f.failed} |`);
    if (over) warnings.push(`::warning file=${file},title=Test time over budget::${suite} took ${seconds(ms)}, over its budget of ${budget} s (test/budgets.json)`);
  }
  const slowest = tests.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST);
  const table = [
    '### Test times',
    '',
    '| Suite | Time | Budget | Tests | Failed |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
    `Slowest ${slowest.length} tests:`,
    '',
    '| Time | Test | Suite |',
    '|---:|---|---|',
    ...slowest.map((t) => `| ${seconds(t.ms)} | ${t.name.replace(/\|/g, '\\|')}${t.failed ? ' (failed)' : ''} | ${t.file} |`),
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  yield `\n${table}\n`;
  for (const w of warnings) yield `${w}\n`;
}
