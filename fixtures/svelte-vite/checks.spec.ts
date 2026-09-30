import type { Checks } from '../../src/index.ts';

export default {
  'the counter increments ($state, onclick)': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Count is 0' }).click();
    await expect(app.getByRole('button', { name: 'Count is 1' })).toBeVisible();
  },
  'todos from a .svelte.ts rune store ({#each}, bind:, $derived)': async ({ app, expect }) => {
    await app.getByLabel('New todo').fill('Write tests');
    await app.getByRole('button', { name: 'Add' }).click();
    await expect(app.getByRole('status')).toHaveText('1 left');
    await app.getByRole('checkbox', { name: 'Write tests' }).check();
    await expect(app.getByRole('status')).toHaveText('0 left');
  },
} satisfies Checks;
