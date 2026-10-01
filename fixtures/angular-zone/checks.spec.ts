import type { Checks } from '../../src/index.ts';

// An Angular 22 CLI welcome page: zone.js change detection, SCSS component styles.
export default {
  'the welcome page renders': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { name: 'Hello, zone' })).toBeVisible();
    await expect(app.getByRole('link', { name: 'Explore the Docs' })).toBeVisible();
  },
} satisfies Checks;
