// Sandburg's result.json as a Harbor reward: the share of the task's checks that passed, and
// whether the run passed (all of them, and Sandburg's own blocking checks).
import { readFileSync, writeFileSync } from 'node:fs';
const [resultPath, rewardPath] = process.argv.slice(2);
let reward = { score: 0, passed: 0 };
try {
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const functional = result.checks.filter((c) => c.kind === 'functional');
  const total = Number(process.env.CHECKS_TOTAL) || functional.length;
  const passed = functional.filter((c) => c.status === 'passed').length;
  reward = { score: total ? passed / total : 0, passed: result.status === 'passed' && passed === total ? 1 : 0 };
  console.log(`${result.status}: ${passed}/${total} checks${result.failure ? ` (${result.failure.class}: ${result.failure.rule})` : ''}`);
} catch (e) {
  console.log(`no result: ${e.message}`);
}
writeFileSync(rewardPath, JSON.stringify(reward) + '\n');
