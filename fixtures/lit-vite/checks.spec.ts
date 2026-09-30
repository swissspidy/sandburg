import type { Checks } from '../../src/index.ts';

export default {
  'the counter increments': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Count is 0' }).click();
    await expect(app.getByRole('button', { name: 'Count is 1' })).toBeVisible();
    await app.getByRole('button', { name: 'Count is 1' }).click();
    await expect(app.getByRole('button', { name: 'Count is 2' })).toBeVisible();
  },
} satisfies Checks;
