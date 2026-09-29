// Checks for the Reading Time plugin. appUrl() keeps Playground's /scope:…/ prefix.
export default {
  'shows reading time on a post': async ({ app, expect, appUrl }) => {
    await app.goto(appUrl('/?p=1'));
    await expect(app.locator('.reading-time')).toHaveText('1 min read');
  },
  'reading speed can be changed in the settings': async ({ app, expect, appUrl }) => {
    await app.goto(appUrl('/wp-admin/options-general.php?page=reading-time'));
    await expect(app.getByRole('heading', { name: 'Reading Time', level: 1 })).toBeVisible();
    await app.getByLabel('Words per minute').fill('1');
    await app.getByRole('button', { name: 'Save Changes' }).click();
    await expect(app.getByText('Settings saved.')).toBeVisible();
    await app.goto(appUrl('/?p=1'));
    // "Hello world!" has 15 words: at 1 word per minute that is 15 minutes.
    await expect(app.locator('.reading-time')).toHaveText('15 min read');
  },
};
