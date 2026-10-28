export default {
  'the workspace and link: packages load, at the versions pnpm-lock.yaml pins': async ({ app, expect }) => {
    await expect(app.getByRole('heading', { level: 1 })).toHaveText('<linked>');
    await expect(app.locator('#ms')).toHaveText('ms 2.0.0');
    await expect(app.locator('#escape')).toHaveText('escape-html 1.0.2');
  },
};
