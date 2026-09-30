import type { Checks } from '../../src/index.ts';

export default {
  'the task list renders with its remaining count': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { name: 'Task board' })).toBeVisible();
    await expect(app.getByRole('status')).toHaveText('1 task left');
  },
  'a task can be added and completed': async ({ app, expect }) => {
    await app.getByLabel('New task').fill('Ship it');
    await app.getByRole('button', { name: 'Add' }).click();
    await expect(app.getByRole('status')).toHaveText('2 tasks left');
    await app.getByRole('checkbox', { name: 'Ship it' }).check();
    await expect(app.getByRole('status')).toHaveText('1 task left');
  },
  'a task can be deleted': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Delete Write the brief' }).click();
    await expect(app.getByText('Write the brief')).toHaveCount(0);
  },
  'the lazily loaded About route renders': async ({ app, expect }) => {
    await app.getByRole('link', { name: 'About' }).click();
    await expect(app.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(app.getByText('Released September 30, 2026.')).toBeVisible();
  },
} satisfies Checks;
