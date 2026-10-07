/**
 * Harbor tasks from the app-gen eval (evals/app-gen): one task per task × stack. The agent starts
 * from the stack's scaffold (the task's environment/ folder, copied into /app) and gets the eval's
 * request and what the generator page tells its model about the runtime. The verifier runs the app
 * in Sandburg with the eval's checks; the reward is the share of checks that pass (`score`) and
 * whether all of them did (`passed`).
 *
 * A task with a follow-up request has two steps: `request`, then `follow-up` if every check of the
 * first passed. The follow-up starts from the first step's app and the database its checks left
 * behind (the verifier writes the app's SQLite files back into /app), as in the eval.
 *
 *   node integrations/harbor/build-tasks.ts [--tasks todo,guestbook] [--stacks vanilla,react]
 *     [--solutions .sandburg/evals/<run>] [--out integrations/harbor/tasks]
 *
 * --solutions takes an eval run's directory: a cell whose request passed gives its task an oracle
 * solution (solution/app/, copied over the scaffold by solve.sh), and one whose follow-up passed
 * too gives the follow-up step one.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME } from '../../pages/generate/prompt.ts';
import { DATA_FILES } from '../../pages/generate/files.ts';
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
# Runs the app in Sandburg (packages installed in the browser) with the task's checks, and keeps the
# database they leave behind in the project for the next step.
mkdir -p /logs/verifier
sandburg run . --install-in browser --checks /tests/checks.ts --out /logs/verifier/sandburg --json \\
  --save-files '${DATA_FILES}' \\
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

const checksTs = (taskId: string, followUp: boolean) => `// The app-gen eval's checks for "${taskId}"${followUp ? "'s follow-up" : ''} (evals/app-gen/suite.ts in Sandburg's repository).
const home = process.env.SANDBURG_HOME;
if (!home) throw new Error('SANDBURG_HOME is not set (the Sandburg environment sets it)');
const { SUITE } = await import(\`\${home}/evals/app-gen/suite.ts\`);
export default SUITE.find((t) => t.id === '${taskId}')${followUp ? '.followUp' : ''}.checks;
`;

const instruction = (prompt: string, project: string) => `${RUNTIME}

## Where you work

${project}

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

/** An eval cell's passing apps: the request's, and the follow-up's if it passed too (from the same cell, preferred). */
async function solutions(taskId: string, stackId: string): Promise<{ request: FileTree; followUp: FileTree | null } | null> {
  if (!values.solutions) return null;
  let best: { request: FileTree; followUp: FileTree | null } | null = null;
  for (const model of ['claude-opus-5-5', 'gemini-3.1-pro-preview']) {
    const cell = join(resolve(values.solutions), `${model}__${stackId}__${taskId}`);
    if (!existsSync(join(cell, 'cell.json'))) continue;
    const { final, edit } = JSON.parse(await readFile(join(cell, 'cell.json'), 'utf8')) as {
      final: { passed: boolean };
      edit?: { final: { passed: boolean } | null } | null;
    };
    if (!final.passed) continue;
    const read = async (file: string) => JSON.parse(await readFile(join(cell, file), 'utf8')) as FileTree;
    if (edit?.final?.passed) return { request: await read('files.json'), followUp: await read('files-edit.json') };
    best ??= { request: await read('files.json'), followUp: null };
  }
  return best;
}

const SOLVE_SH = '#!/bin/bash\n# A passing app from an eval run, over the project.\ncp -R /solution/app/. /app/\n';

async function writeSolution(dir: string, files: FileTree): Promise<void> {
  await writeTree(join(dir, 'app'), files);
  await writeFile(join(dir, 'solve.sh'), SOLVE_SH);
}

const scaffold = (stack: string) => `The project in the current directory is the scaffold to start from: ${stack}`;
const continued = (prompt: string) => `The project in the current directory is an app built for this request:

> ${prompt.replace(/\n/g, '\n> ')}

People have used it: its database file holds what they entered. Keep that data through your change.`;

for (const task of tasks) {
  for (const tpl of stacks) {
    const name = `${task.id}-${tpl.id}`;
    const dir = join(out, name);
    const total = (checks: object) => Object.keys(checks).length;
    await rm(dir, { recursive: true, force: true });
    await writeTree(join(dir, 'environment'), tpl.files);
    await writeTree(join(dir, 'tests'), { 'test.sh': TEST_SH, 'reward.mjs': REWARD_MJS });
    const solved = await solutions(task.id, tpl.id);
    let config = `schema_version = "1.4"
${task.followUp ? 'multi_step_reward_strategy = "mean"\n' : ''}
[task]
name = "sandburg/${name}"
description = "App-gen eval task ${task.id} on ${tpl.label}${task.followUp ? ', and its follow-up request' : ''}, run in Sandburg."
keywords = ["sandburg", "web-app", "${tpl.id}"]
`;
    config += `
[agent]
timeout_sec = 1200.0

[verifier]
timeout_sec = 900.0
`;
    if (!task.followUp) {
      config += `
[verifier.env]
CHECKS_TOTAL = "${total(task.checks)}"
`;
    }
    config += `
[environment]
workdir = "/app"
`;
    if (!task.followUp) {
      await writeFile(join(dir, 'instruction.md'), instruction(task.prompt, scaffold(tpl.stack)));
      await writeFile(join(dir, 'tests', 'checks.ts'), checksTs(task.id, false));
      if (solved) await writeSolution(join(dir, 'solution'), solved.request);
    } else {
      // The follow-up runs only if the request's app passed every check, as in the eval.
      config += `
[[steps]]
name = "request"
min_reward = { passed = 1.0 }

[steps.verifier.env]
CHECKS_TOTAL = "${total(task.checks)}"

[[steps]]
name = "follow-up"

[steps.verifier.env]
CHECKS_TOTAL = "${total(task.followUp.checks)}"
`;
      const request = join(dir, 'steps', 'request');
      await writeTree(request, { 'instruction.md': instruction(task.prompt, scaffold(tpl.stack)), 'tests/checks.ts': checksTs(task.id, false) });
      if (solved) await writeSolution(join(request, 'solution'), solved.request);
      const followUp = join(dir, 'steps', 'follow-up');
      await writeTree(followUp, { 'instruction.md': instruction(task.followUp.prompt, continued(task.prompt)), 'tests/checks.ts': checksTs(task.id, true) });
      if (solved?.followUp) await writeSolution(join(followUp, 'solution'), solved.followUp);
    }
    await writeFile(join(dir, 'task.toml'), config);
    const has = !solved ? '' : task.followUp && !solved.followUp ? ' (with a solution for the request only)' : ' (with solution)';
    console.log(`${name}${has}`);
  }
}
