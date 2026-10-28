export default {
  'the app renders with its workspace and file: packages': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('HELLO, MONOREPO, FOR 1 MINUTE!');
    // package-lock.json's version (^2.1.0 would be 2.1.3 without it).
    await expect(app.locator('#ms')).toHaveText('ms 2.1.2');
    // apps/web's ms ^2.1.1 and @acme/greet's ^2.1.0 are one copy.
    await expect(app.locator('#copies')).toHaveText('one ms');
  },
};
