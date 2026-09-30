export default {
  'notes can be saved through the Express API': async ({ app, expect }) => {
    await app.getByLabel('Note', { exact: true }).fill('Runs in the browser');
    await app.getByRole('button', { name: 'Save' }).click();
    await expect(app.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveText(['Runs in the browser']);
  },
};
