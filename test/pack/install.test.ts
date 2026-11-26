/**
 * The npm package: packed (which builds dist/), installed into an empty project with Playwright (an
 * optional peer dependency), its CLI runs a project and passes its checks, and its library and types
 * load from there. Installed without Playwright, its browser runtime is there for an embedder, and
 * the CLI says what to install. Installing needs network access to the npm registry, and the run
 * needs Chromium (npx playwright install chromium).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDir = join(root, 'fixtures/vite-react-counter');
let dir: string;
/** A consumer that installed the package alone, without Playwright: an embedder of the browser runtime. */
let bare: string;
let files: string[];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sandburg-pack-'));
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root, maxBuffer: 64 << 20 });
  const [pack] = JSON.parse(stdout.slice(stdout.indexOf('['))) as { filename: string; files: { path: string }[] }[];
  files = pack.files.map((f) => f.path);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  const { peerDependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> };
  const peers = Object.entries(peerDependencies).map(([name, version]) => `${name}@${version}`);
  // Not inside the first consumer: Node would find its Playwright there.
  bare = await mkdtemp(join(tmpdir(), 'sandburg-pack-bare-'));
  await writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'embedder', private: true, type: 'module' }));
  await Promise.all([
    run('npm', ['install', '--no-audit', '--no-fund', join(dir, pack.filename), ...peers], { cwd: dir, maxBuffer: 64 << 20 }),
    run('npm', ['install', '--no-audit', '--no-fund', join(dir, pack.filename)], { cwd: bare, maxBuffer: 64 << 20 }),
  ]);
});
after(() => Promise.all([rm(dir, { recursive: true, force: true }), bare && rm(bare, { recursive: true, force: true })]));

test('the package holds the CLI, its build and the sources the page is bundled from, and nothing else', () => {
  const outside = files.filter((f) => !/^(bin|dist|src)\//.test(f) && !['package.json', 'README.md', 'LICENSE'].includes(f));
  assert.deepEqual(outside, []);
  for (const f of [
    'bin/sandburg.js',
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    'src/host/host.ts',
    'src/node-runtime/worker.ts',
    'src/adapters/node/sw.js',
    'src/page-checks/runtime.ts',
    // The browser runtime, prebuilt (ADR 0074).
    'dist/browser-runtime/index.js',
    'dist/browser-runtime/index.d.ts',
    'dist/browser-runtime/sw.js',
    'dist/browser-runtime/host.js',
    'dist/browser-runtime/runtime/node-worker.js',
    'dist/browser-runtime/runtime/esbuild.wasm',
  ]) {
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

test('the installed CLI runs a checks file in the page (its runtime bundled from the installed packages)', async () => {
  const checks = join(dir, 'page.spec.ts');
  await writeFile(
    checks,
    `export default {
  'counter increments on click': async ({ app, expect }) => {
    await app.getByRole('button', { name: /count is/ }).click();
    await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 1');
  },
};
`,
  );
  const { stdout } = await run(join(dir, 'node_modules/.bin/sandburg'), ['run', fixtureDir, '--checks', checks, '--checks-in', 'page', '--json'], {
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

test('installed without Playwright, the browser runtime is there for an embedder, and the CLI says what to install', async () => {
  assert.ok(!existsSync(join(bare, 'node_modules/playwright-core')), 'Playwright is not installed with the package');
  assert.ok(!existsSync(join(bare, 'node_modules/@playwright/test')));
  // An embedder finds the runtime's files through the package's exports, to serve them.
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('sandburg/browser-runtime'), import.meta.resolve('sandburg/browser-runtime/sw.js'))"], { cwd: bare });
  const [api, sw] = stdout.trim().split(' ').map((u) => new URL(u));
  assert.ok(existsSync(api) && existsSync(sw), stdout);
  assert.ok(existsSync(new URL('runtime/node-worker.js', sw)), 'runtime/ is beside sw.js');
  const failed = await run(join(bare, 'node_modules/.bin/sandburg'), ['run', fixtureDir], { cwd: bare }).then(
    () => assert.fail('the CLI should fail'),
    (err: { code: number; stderr: string }) => err,
  );
  assert.equal(failed.code, 2);
  // The embedder has Sandburg in its dependencies: the peers go there too, and Sandburg stays a production dependency.
  assert.match(failed.stderr, /needs Playwright, which is not installed \((?:playwright-core|@playwright\/test)\)\. Run: npm install @playwright\/test@\S+ playwright-core@\S+$/m);
});
