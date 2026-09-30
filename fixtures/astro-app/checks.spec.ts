import type { Checks } from '../../src/index.ts';

export default {
  'the page is rendered with data from the frontmatter': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { name: 'Welcome to Astro' })).toBeVisible();
    await expect(app.getByText('Rendered by Astro with 4 planets.')).toBeVisible();
    await expect(app.getByRole('listitem')).toHaveCount(4);
  },
  'client scripts run': async ({ app, expect }) => {
    await expect(async () => {
      await app.getByRole('button', { name: /Clicked \d+ times/ }).click();
      await expect(app.getByRole('button', { name: /Clicked [1-9]\d* times/ })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 60_000 });
  },
  'an API endpoint responds': async ({ app, expect }) => {
    await expect(app.getByText('Hello from an Astro endpoint')).toBeVisible();
  },
  'navigation to another page': async ({ app, expect }) => {
    await app.getByRole('link', { name: 'About' }).click();
    await expect(app.getByRole('heading', { name: 'About' })).toBeVisible();
  },
} satisfies Checks;
