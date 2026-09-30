import type { Checks } from '../../src/index.ts';

export default {
  'the counter increments (signals, compiled JSX)': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Count is 0' }).click();
    await expect(app.getByRole('button', { name: 'Count is 1' })).toBeVisible();
  },
  '<For> renders a growing list': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Add item' }).click();
    await app.getByRole('button', { name: 'Add item' }).click();
    await expect(app.getByRole('list', { name: 'Items' }).getByRole('listitem')).toHaveText(['Item 1', 'Item 2']);
  },
} satisfies Checks;
