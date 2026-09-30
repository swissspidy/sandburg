/**
 * Angular CLI apps run `ng serve` in the node runtime (ADR 0014): the app's own
 * @angular/build compiles, bundles and serves it, in the browser. Template and
 * type errors are app bugs, as `ng serve` reports them.
 *
 * Dependencies are installed on the host from the npm registry (cached in
 * .sandburg/installs), so the first run needs network access.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject, projectFromFiles } from '../../src/project.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
const tasks = fixture('angular-tasks');

let session: Session;
before(async () => {
  session = new Session();
  await session.open();
});
after(() => session?.close());

const failures = (r: Awaited<ReturnType<Session['run']>>) => JSON.stringify(r.failure ?? r.checks.filter((c) => c.status !== 'passed'), null, 2);

test('an Angular 22 CLI app (signals, forms, lazy route) runs and passes its checks', async () => {
  const result = await session.run(tasks, { checks: `${tasks}/checks.spec.ts`, outDir });
  assert.equal(result.project.framework, 'angular');
  assert.equal(result.status, 'passed', failures(result));
  assert.equal(result.checks.filter((c) => c.kind === 'functional' && c.status === 'passed').length, 4);
});

test('an Angular 19 CLI app with zone.js and SCSS runs', async () => {
  const dir = fixture('angular-19-zone');
  const result = await session.run(dir, { checks: `${dir}/checks.spec.ts`, outDir });
  assert.equal(result.status, 'passed', failures(result));
});

test('a template error fails the compile as an app bug, with its location', async () => {
  const base = await loadProject(tasks);
  const html = (base.files['src/app/tasks/task-list.html'] as string).replace('store.remaining()', 'store.remainingCount()');
  const broken = projectFromFiles({ ...base.files, 'src/app/tasks/task-list.html': html }, { name: 'angular-template-error', path: tasks });
  const result = await session.run(broken, { outDir });
  assert.equal(result.status, 'error');
  assert.equal(result.failure?.class, 'app-bug');
  assert.equal(result.failure?.phase, 'start');
  assert.match(result.failure!.message, /src\/app\/tasks\/task-list\.html:\d+:\d+: TS2339: Property 'remainingCount' does not exist/);
});

test('Tailwind CSS v4 via @tailwindcss/postcss is applied', async () => {
  const base = await loadProject(tasks);
  const pkg = JSON.parse(base.files['package.json'] as string);
  Object.assign(pkg.devDependencies, { tailwindcss: '4.1.14', '@tailwindcss/postcss': '4.1.14', postcss: '^8.5.0' });
  const project = projectFromFiles(
    {
      ...base.files,
      'package.json': JSON.stringify(pkg),
      '.postcssrc.json': JSON.stringify({ plugins: { '@tailwindcss/postcss': {} } }),
      'src/styles.css': '@import "tailwindcss";\n',
      'src/app/app.html': (base.files['src/app/app.html'] as string).replace('<h1>', '<h1 class="text-3xl font-bold">'),
    },
    { name: 'angular-tailwind', path: tasks },
  );
  const dir = await mkdtemp(join(tmpdir(), 'sandburg-ng-tw-'));
  const checks = join(dir, 'checks.spec.ts');
  await writeFile(checks, `export default { 'utilities apply': async ({ app, expect }) => { await expect(app.getByRole('heading', { name: 'Task board' })).toHaveCSS('font-size', '30px'); } };\n`);
  const result = await session.run(project, { checks, outDir });
  assert.equal(result.status, 'passed', failures(result));
});

test('Sass @use of a package (the Angular CDK) is resolved by the CLI\'s importer', async () => {
  const base = await loadProject(tasks);
  const pkg = JSON.parse(base.files['package.json'] as string);
  pkg.dependencies['@angular/cdk'] = pkg.dependencies['@angular/core'];
  const { 'src/styles.css': _css, ...files } = base.files;
  const project = projectFromFiles(
    {
      ...files,
      'package.json': JSON.stringify(pkg),
      'angular.json': (base.files['angular.json'] as string).replace('"src/styles.css"', '"src/styles.scss"'),
      'src/styles.scss': "@use '@angular/cdk' as cdk;\n\n@include cdk.a11y-visually-hidden();\n",
      'src/index.html': (base.files['src/index.html'] as string).replace('<body>', '<body>\n  <span class="cdk-visually-hidden" data-testid="hidden">only for screen readers</span>'),
    },
    { name: 'angular-sass-package', path: tasks },
  );
  const tmp = await mkdtemp(join(tmpdir(), 'sandburg-ng-sass-'));
  const checks = join(tmp, 'checks.spec.ts');
  await writeFile(checks, `export default { 'the CDK mixin applies': async ({ app, expect }) => { const el = app.getByTestId('hidden'); await expect(el).toHaveCSS('position', 'absolute'); await expect(el).toHaveCSS('width', '1px'); } };\n`);
  const result = await session.run(project, { checks, outDir });
  assert.equal(result.status, 'passed', failures(result));
});
