import type { Checks } from '../../src/index.ts';

export default {
  'seeded notes load from the API, pinned first': async ({ app, expect }) => {
    await expect(app.getByRole('status')).toHaveText('2 notes, 1 pinned');
    await expect(app.getByRole('listitem').first()).toContainText('Call the plumber');
  },
  'a note is saved in the database and survives a reload': async ({ app, expect, appUrl }) => {
    await app.getByLabel('New note').fill('Water the plants');
    await app.getByRole('button', { name: 'Add' }).click();
    await expect(app.getByRole('status')).toHaveText('3 notes, 1 pinned');
    await app.goto(appUrl('/'));
    await expect(app.getByText('Water the plants')).toBeVisible();
  },
  'pinning moves a note to the top': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Pin Buy oat milk' }).click();
    await expect(app.getByRole('status')).toHaveText(/2 pinned/);
  },
  'validation errors from the API are shown': async ({ app, expect }) => {
    await app.getByRole('button', { name: 'Add' }).click();
    await expect(app.getByRole('alert')).toHaveText('text is required');
  },
} satisfies Checks;
