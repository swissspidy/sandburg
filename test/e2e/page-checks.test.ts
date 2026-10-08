/**
 * End-to-end: checks that run in the page (--checks-in page, ADR 0023) on the Vite + React fixture.
 * Their code runs in the sandbox tab with ivya's locators and user-event's input, and reports as
 * checks run here do: failed for an assertion or a wait that timed out, error for a broken check.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '../../src/orchestrator/session.ts';
import { loadProject } from '../../src/project.ts';
import type { Project, RunResult } from '../../src/types.ts';

const fixtureDir = fileURLToPath(new URL('../../fixtures/vite-react-counter', import.meta.url));
const outDir = fileURLToPath(new URL('../../.sandburg/test-runs', import.meta.url));
let session: Session;
let counter: Project;
let dir: string;

before(async () => {
  session = new Session();
  await session.open();
  counter = await loadProject(fixtureDir);
  dir = await mkdtemp(join(tmpdir(), 'sandburg-page-checks-'));
});
after(() => session.close());

const functional = (r: RunResult) => Object.fromEntries(r.checks.filter((c) => c.kind === 'functional').map((c) => [c.name, c]));

async function checksFile(name: string, code: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, code);
  return file;
}

test("the fixture's own checks pass in the page", async () => {
  const result = await session.run(counter, { checks: `${fixtureDir}/checks.spec.ts`, checksIn: 'page', outDir });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure ?? result.checks, null, 2));
  assert.equal(Object.keys(functional(result)).length, 2);
});

test('locators, actions and expect behave as in Playwright, and failures read like its', async () => {
  const file = await checksFile(
    'behaviour.spec.ts',
    `import type { Checks } from 'sandburg';
export default {
  'Node is not here': async ({ expect }) => {
    expect(typeof process).toBe('undefined');
    expect(typeof require).toBe('undefined');
  },
  'adds todos with Enter and the button, filters and counts them': async ({ app, expect }) => {
    await app.getByLabel('New todo').fill('Buy {milk} [now]');
    await app.getByLabel('New todo').press('Enter');
    await app.getByLabel('New todo').fill('Walk the dog');
    await app.getByRole('button', { name: 'Add' }).click();
    const items = app.getByRole('list', { name: 'Todos' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items).toHaveText(['Buy {milk} [now]', 'Walk the dog']);
    await expect(items.first()).toContainText('milk');
    await expect(items.filter({ hasText: 'dog' })).toHaveCount(1);
    await items.last().getByRole('checkbox').check();
    await expect(app.getByRole('checkbox', { name: 'Walk the dog' })).toBeChecked();
    await expect(app.getByRole('checkbox', { name: /milk/ })).not.toBeChecked();
    expect(await items.allTextContents()).toEqual(['Buy {milk} [now]', 'Walk the dog']);
  },
  'a reload starts over': async ({ app, expect }) => {
    await app.getByRole('button', { name: /count is/ }).click();
    await app.reload();
    await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 0');
    let n = 0;
    await expect.poll(() => ++n, { timeout: 2000 }).toBeGreaterThan(3);
  },
  'a failing assertion': async ({ app, expect }) => {
    await expect(app.getByRole('button', { name: /count is/ })).toHaveText('count is 9', { timeout: 300 });
  },
  'an element that never comes': async ({ app }) => {
    await app.getByRole('button', { name: 'Delete' }).click({ timeout: 300 });
  },
  'two elements where one is meant': async ({ app }) => {
    await app.getByRole('button').click();
  },
  'a broken check': async () => {
    (null as unknown as { x: number }).x;
  },
  'what is not here says so': async ({ app }) => {
    (app as unknown as { frameLocator(s: string): unknown }).frameLocator('iframe');
  },
} satisfies Checks;
`,
  );
  const result = await session.run(counter, { checks: file, checksIn: 'page', outDir });
  const c = functional(result);
  for (const name of ['Node is not here', 'adds todos with Enter and the button, filters and counts them', 'a reload starts over']) {
    assert.equal(c[name]?.status, 'passed', `${name}: ${c[name]?.message}`);
  }
  assert.equal(c['a failing assertion'].status, 'failed');
  assert.match(c['a failing assertion'].message!, /expect\(locator\)\.toHaveText\(expected\) failed/);
  assert.match(c['a failing assertion'].message!, /Locator: getByRole\('button', \{ name: \/count is\/ \}\)/);
  assert.match(c['a failing assertion'].message!, /Expected string: "count is 9"\nReceived: "count is 0"/);
  assert.equal(c['an element that never comes'].status, 'failed');
  assert.match(c['an element that never comes'].message!, /locator\.click: Timeout 300ms exceeded/);
  assert.equal(c['two elements where one is meant'].status, 'error');
  assert.match(c['two elements where one is meant'].message!, /strict mode violation: getByRole\('button'\) resolved to 2 elements/);
  assert.equal(c['a broken check'].status, 'error');
  assert.equal(c['what is not here says so'].status, 'error');
  assert.match(c['what is not here says so'].message!, /app\.frameLocator is not available in checks that run in the page/);
});

test('a checks file that imports something does not load: nothing is resolved or run here', async () => {
  const marker = join(dir, 'ran-on-the-host');
  const file = await checksFile(
    'imports.spec.ts',
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'yes');
export default { 'never runs': () => {} };
`,
  );
  const result = await session.run(counter, { checks: file, checksIn: 'page', outDir });
  const c = functional(result);
  assert.equal(c['checks file']?.status, 'error');
  assert.match(c['checks file'].message!, /the checks file did not load/);
  await assert.rejects(import('node:fs/promises').then((fs) => fs.access(marker)));
});
