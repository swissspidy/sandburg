/**
 * Harbor tasks from the app-gen eval (evals/app-gen): one task per task × stack. The agent starts
 * from the stack's scaffold (the task's environment/ folder, copied into /app) and gets the eval's
 * request and what the generator page tells its model about the runtime. The verifier runs the app
 * in Sandburg with the eval's checks; the reward is the share of checks that pass (`score`) and
 * whether all of them did (`passed`).
 *
 *   node integrations/harbor/build-tasks.ts [--tasks todo,guestbook] [--stacks vanilla,react]
 *     [--solutions .sandburg/evals/<run>] [--out integrations/harbor/tasks]
 *
 * --solutions takes an eval run's directory: a cell whose first request passed gives its task an
 * oracle solution (solution/app/, copied over the scaffold by solve.sh).
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME } from '../../pages/generate/prompt.ts';
import { TEMPLATES } from '../../pages/generate/templates.ts';
import { SUITE } from '../../evals/app-gen/suite.ts';
import type { FileTree } from '../../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    tasks: { type: 'string' },
    stacks: { type: 'string', default: 'vanilla,react' },
    solutions: { type: 'string' },
    out: { type: 'string', default: join(here, 'tasks') },
  },
});

const pick = <T extends { id: string }>(all: T[], ids: string | undefined, kind: string): T[] =>
  ids
    ? ids.split(',').map((id) => all.find((x) => x.id === id) ?? fail(`unknown ${kind} ${id} (${all.map((x) => x.id).join(', ')})`))
    : all;
const fail = (message: string): never => {
  throw new Error(message);
};

const tasks = pick(SUITE, values.tasks, 'task');
const stacks = pick(TEMPLATES, values.stacks, 'stack');
const out = resolve(values.out);

const TEST_SH = `#!/bin/bash
# Runs the app in Sandburg (packages installed in the browser) with the task's checks.
mkdir -p /logs/verifier
sandburg run . --install-in browser --checks /tests/checks.ts --out /logs/verifier/sandburg --json \\
  > /logs/verifier/sandburg-result.json 2> /logs/verifier/sandburg.log
node /tests/reward.mjs /logs/verifier/sandburg-result.json /logs/verifier/reward.json
`;

const REWARD_MJS = `// Sandburg's result.json as a Harbor reward: the share of the task's checks that passed, and
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
  console.log(\`\${result.status}: \${passed}/\${total} checks\${result.failure ? \` (\${result.failure.class}: \${result.failure.rule})\` : ''}\`);
} catch (e) {
  console.log(\`no result: \${e.message}\`);
}
writeFileSync(rewardPath, JSON.stringify(reward) + '\\n');
`;

const checksTs = (taskId: string) => `// The app-gen eval's checks for "${taskId}" (evals/app-gen/suite.ts in Sandburg's repository).
const home = process.env.SANDBURG_HOME;
if (!home) throw new Error('SANDBURG_HOME is not set (the Sandburg environment sets it)');
const { SUITE } = await import(\`\${home}/evals/app-gen/suite.ts\`);
export default SUITE.find((t) => t.id === '${taskId}').checks;
`;

const instruction = (prompt: string, stack: string) => `${RUNTIME}

## Where you work

The project in the current directory is the scaffold to start from: ${stack}

You edit its files here; you cannot run \`npm\`, \`node\` or the app on this machine. To run it, use
\`sandburg run . --install-in browser\`: it installs the packages and starts the dev server in a
browser tab, and reports whether the app rendered, the dev server's errors and the page's
console errors. Add \`--json\` for the whole result, including the run's log. It also writes a
screenshot and the page's accessibility tree; their paths are in the summary. Run it again after
a change. Your work is checked the same way, in a fresh browser.

## Task

${prompt}
`;

async function writeTree(dir: string, files: FileTree): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'));
  }
}

async function solution(taskId: string, stackId: string): Promise<FileTree | null> {
  if (!values.solutions) return null;
  for (const model of ['claude-opus-5-5', 'gemini-3.1-pro-preview']) {
    const cell = join(resolve(values.solutions), `${model}__${stackId}__${taskId}`);
    if (!existsSync(join(cell, 'cell.json'))) continue;
    const { final } = JSON.parse(await readFile(join(cell, 'cell.json'), 'utf8')) as { final: { passed: boolean } };
    if (final.passed) return JSON.parse(await readFile(join(cell, 'files.json'), 'utf8')) as FileTree;
  }
  return null;
}

for (const task of tasks) {
  for (const tpl of stacks) {
    const name = `${task.id}-${tpl.id}`;
    const dir = join(out, name);
    await rm(dir, { recursive: true, force: true });
    await writeTree(join(dir, 'environment'), tpl.files);
    await writeFile(join(dir, 'instruction.md'), instruction(task.prompt, tpl.stack));
    await writeFile(
      join(dir, 'task.toml'),
      `schema_version = "1.4"

[task]
name = "sandburg/${name}"
description = "App-gen eval task ${task.id} on ${tpl.label}, run in Sandburg."
keywords = ["sandburg", "web-app", "${tpl.id}"]

[agent]
timeout_sec = 1200.0

[verifier]
timeout_sec = 900.0

[verifier.env]
CHECKS_TOTAL = "${Object.keys(task.checks).length}"

[environment]
workdir = "/app"
`,
    );
    await writeTree(join(dir, 'tests'), { 'test.sh': TEST_SH, 'checks.ts': checksTs(task.id), 'reward.mjs': REWARD_MJS });
    const solved = await solution(task.id, tpl.id);
    if (solved) {
      await writeTree(join(dir, 'solution', 'app'), solved);
      await writeFile(join(dir, 'solution', 'solve.sh'), '#!/bin/bash\n# A passing app from an eval run, over the scaffold.\ncp -R /solution/app/. /app/\n');
    }
    console.log(`${name}${solved ? ' (with solution)' : ''}`);
  }
}
