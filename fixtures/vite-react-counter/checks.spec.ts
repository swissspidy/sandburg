import type { Checks } from '../../src/index.ts';

export default {
  'counter increments on click': async ({ app, expect }) => {
    const button = app.getByRole('button', { name: /count is/ });
    await expect(button).toHaveText('count is 0');
    await button.click();
    await button.click();
    await expect(button).toHaveText('count is 2');
  },
  'todo can be added and completed': async ({ app, expect }) => {
    await app.getByLabel('New todo').fill('Write the ADR');
    await app.getByRole('button', { name: 'Add' }).click();
    const item = app.getByRole('list', { name: 'Todos' }).getByRole('listitem');
    await expect(item).toHaveText('Write the ADR');
    await item.getByRole('checkbox').check();
    await expect(item.getByRole('checkbox')).toBeChecked();
  },
} satisfies Checks;
