import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { currentApiReports, ENTRIES } from '../../scripts/api-report.ts';

// The package's API (what a consumer's TypeScript sees from 'sandburg' and 'sandburg/browser-runtime')
// is the checked-in reports: a change to one, on purpose, is `node scripts/api-report.ts --update` and
// a reviewed diff.
const reports = currentApiReports();

test('every entry point with declarations in package.json has a report', () => {
  assert.deepEqual(ENTRIES.map((e) => e.name), ['sandburg', 'sandburg/browser-runtime']);
});

for (const entry of ENTRIES) {
  const file = relative(process.cwd(), entry.report);
  test(`the public API of ${entry.name} is the one in ${file}`, () => {
    assert.equal(reports.get(entry.report), readFileSync(entry.report, 'utf8'), `the API changed: if on purpose, run node scripts/api-report.ts --update and commit ${file}`);
  });

  test(`every declaration ${entry.name} exports has a doc comment`, () => {
    assert.match(reports.get(entry.report)!, /exported without a doc comment \(0\)/);
  });
}
