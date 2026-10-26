import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentApiReport, REPORT } from '../../scripts/api-report.ts';

// The package's API (what a consumer's TypeScript sees from 'sandburg') is the checked-in report:
// a change to it, on purpose, is `node scripts/api-report.ts --update` and a reviewed diff.
test('the public API is the one in api/sandburg.api.md', () => {
  const report = currentApiReport();
  assert.equal(report, readFileSync(REPORT, 'utf8'), 'the API changed: if on purpose, run node scripts/api-report.ts --update and commit api/sandburg.api.md');
});

test('every declaration the package exports has a doc comment', () => {
  assert.match(currentApiReport(), /exported without a doc comment \(0\)/);
});
