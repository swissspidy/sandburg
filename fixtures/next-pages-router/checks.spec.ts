import type { Checks } from '../../src/index.ts';

export default {
  'API route answers': async ({ app, expect }) => {
    await expect(app.getByRole('status')).toHaveText('Keep the streak going!');
  },
  'marking a habit done increments its streak': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Done today: Read' }).click();
    await expect(app.getByTestId('streak-1')).toHaveText('1 days');
  },
  'a habit can be added': async ({ app, expect }) => {
    await app.getByLabel('New habit').fill('Stretch');
    await app.getByRole('button', { name: 'Add habit' }).click();
    await expect(app.getByRole('list', { name: 'Habits' }).getByRole('listitem')).toHaveCount(3);
  },
} satisfies Checks;
