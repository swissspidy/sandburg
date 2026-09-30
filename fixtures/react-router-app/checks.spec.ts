import type { Checks } from '../../src/index.ts';

export default {
  'the page is server-rendered with loader data': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { name: 'Welcome to React Router' })).toBeVisible();
    await expect(app.getByText('Data from the server loader.')).toBeVisible();
  },
  'the page hydrates and is interactive': async ({ app, expect }) => {
    // The server-rendered button is visible before the client (dev modules) hydrates it.
    await expect(async () => {
      await app.getByRole('button', { name: /Clicked \d+ times/ }).click();
      await expect(app.getByRole('button', { name: /Clicked [1-9]\d* times/ })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 60_000 });
  },
  'a form posts to the route action': async ({ app, expect }) => {
    await app.getByRole('textbox', { name: 'New todo' }).fill('Ship it');
    await app.getByRole('button', { name: 'Add' }).click();
    await expect(app.getByRole('listitem').filter({ hasText: 'Ship it' })).toBeVisible();
  },
  'client-side navigation to another route': async ({ app, expect }) => {
    await app.getByRole('link', { name: 'About' }).click();
    await expect(app.getByRole('heading', { name: 'About' })).toBeVisible();
  },
} satisfies Checks;
