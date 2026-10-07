/**
 * The npm package: packed (which builds dist/), installed into an empty project, its CLI runs
 * a project and passes its checks, and its library and types load from there. Installing needs
 * network access to the npm registry, and the run needs Chromium (npx playwright install chromium).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDir = join(root, 'fixtures/vite-react-counter');
let dir: string;
let files: string[];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sandburg-pack-'));
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root, maxBuffer: 64 << 20 });
  const [pack] = JSON.parse(stdout.slice(stdout.indexOf('['))) as { filename: string; files: { path: string }[] }[];
  files = pack.files.map((f) => f.path);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  await run('npm', ['install', '--no-audit', '--no-fund', join(dir, pack.filename)], { cwd: dir, maxBuffer: 64 << 20 });
});
after(() => rm(dir, { recursive: true, force: true }));

test('the package holds the CLI, its build and the sources the page is bundled from, and nothing else', () => {
  const outside = files.filter((f) => !/^(bin|dist|src)\//.test(f) && !['package.json', 'README.md', 'LICENSE'].includes(f));
  assert.deepEqual(outside, []);
  for (const f of ['bin/sandburg.js', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'src/host/host.ts', 'src/node-runtime/worker.ts', 'src/adapters/node/sw.js']) {
    assert.ok(files.includes(f), f);
  }
});

test('the installed CLI runs a project and its checks', async () => {
  // A checks file of the consumer's own, typed by the installed package.
  const checks = join(dir, 'checks.spec.ts');
  await writeFile(
    checks,
    `import type { Checks } from 'sandburg';
export default {
  'counter increments on click': async ({ app, expect }) => {
    const button = app.getByRole('button', { name: /count is/ });
    await button.click();
    await expect(button).toHaveText('count is 1');
  },
} satisfies Checks;
`,
  );
  const { stdout } = await run(join(dir, 'node_modules/.bin/sandburg'), ['run', fixtureDir, '--checks', checks, '--json'], {
    cwd: dir,
    maxBuffer: 64 << 20,
    timeout: 300_000,
  });
  const result = JSON.parse(stdout) as { status: string; checks: { name: string; status: string }[] };
  assert.equal(result.status, 'passed', stdout);
  assert.ok(result.checks.some((c) => c.name === 'counter increments on click' && c.status === 'passed'));
});

test('without Chromium, the CLI says how to install the one its Playwright drives', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, 'no-browsers') };
  delete env.SANDBURG_CHROMIUM;
  const failed = await run(join(dir, 'node_modules/.bin/sandburg'), ['run', fixtureDir], { cwd: dir, env }).then(
    () => assert.fail('the run should fail'),
    (err: { stderr: string }) => err,
  );
  const { version } = (await import(join(dir, 'node_modules/playwright-core/package.json'), { with: { type: 'json' } })).default as { version: string };
  assert.match(failed.stderr, new RegExp(`npx playwright@${version.replaceAll('.', '\\.')} install chromium`));
});

test('the library loads from the build and its types check', async () => {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', "const s = await import('sandburg'); console.log(typeof s.Session, typeof s.runProject)"], { cwd: dir });
  assert.equal(stdout.trim(), 'function function');

  await writeFile(
    join(dir, 'use.ts'),
    `import { Session, type Checks, type RunResult } from 'sandburg';
const checks: Checks = { 'has a heading': async ({ app, expect }) => expect(app.getByRole('heading')).toBeVisible() };
export async function first(dir: string): Promise<RunResult['status']> {
  const session = new Session();
  await session.open();
  try {
    return (await session.run(dir, { checks })).status;
  } finally {
    await session.close();
  }
}
`,
  );
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', strict: true, noEmit: true, types: ['node'] }, files: ['use.ts'] }),
  );
  // The repository's TypeScript and Node types; the consumer's own would do the same.
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir, '--typeRoots', join(root, 'node_modules/@types')], { cwd: dir });
});
