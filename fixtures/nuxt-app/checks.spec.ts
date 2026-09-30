import type { Checks } from '../../src/index.ts';

export default {
  'the page is server-rendered with data from a server route': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { name: 'Welcome to Nuxt' })).toBeVisible();
    await expect(app.getByText('Hello from a Nitro server route')).toBeVisible();
  },
  'the page hydrates and is interactive': async ({ app, expect }) => {
    // The server-rendered button is visible before the client (dev modules) hydrates it.
    await expect(async () => {
      await app.getByRole('button', { name: /Clicked \d+ times/ }).click();
      await expect(app.getByRole('button', { name: /Clicked [1-9]\d* times/ })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 60_000 });
  },
  'client-side navigation to another page': async ({ app, expect }) => {
    await app.getByRole('link', { name: 'About' }).click();
    await expect(app.getByRole('heading', { name: 'About' })).toBeVisible();
  },
} satisfies Checks;
