import type { Checks } from '../../src/index.ts';

export default {
  'socket.io connects and upgrades to a WebSocket': async ({ app, expect }) => {
    await expect(app.getByRole('status')).toHaveText('connected via websocket', { timeout: 15_000 });
  },
  'a message round-trips through the server': async ({ app, expect }) => {
    await app.getByRole('textbox', { name: 'Message' }).fill('hello over websockets');
    await app.getByRole('button', { name: 'Send' }).click();
    await expect(app.getByRole('list', { name: 'Messages' }).getByText('hello over websockets')).toBeVisible();
  },
} satisfies Checks;
