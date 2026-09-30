import type { Checks } from '../../src/index.ts';

export default {
  'the list starts empty': async ({ app, expect }) => {
    await expect(app.getByRole('status')).toHaveText('0 saved');
  },
  'a bookmark is saved through the API (localhost:4000 via axios)': async ({ app, expect }) => {
    await app.getByLabel('Title').fill('Sandburg');
    await app.getByLabel('URL').fill('https://example.com/sandburg');
    await app.getByRole('button', { name: 'Save' }).click();
    await expect(app.getByRole('link', { name: 'Sandburg' })).toBeVisible();
    await expect(app.getByRole('status')).toHaveText('1 saved');
  },
  'a duplicate URL is rejected by the database constraint': async ({ app, expect }) => {
    await app.getByLabel('Title').fill('Again');
    await app.getByLabel('URL').fill('https://example.com/sandburg');
    await app.getByRole('button', { name: 'Save' }).click();
    await expect(app.getByRole('alert')).toHaveText('already bookmarked');
  },
} satisfies Checks;
