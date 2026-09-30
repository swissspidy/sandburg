import type { Checks } from '../../src/index.ts';

// Hot reloading: an edit to a page reaches the browser over Next.js' HMR WebSocket, without a reload.
export default {
  'an edited page updates in place (HMR)': async ({ app, page, expect }) => {
    await expect(app.getByRole('heading', { name: 'Habit tracker' })).toBeVisible();
    await app.evaluate(() => ((window as unknown as { __marker: string }).__marker = 'still here'));
    await page.evaluate(() =>
      (window as unknown as { __sandburgWriteFile(p: string, c: string): void }).__sandburgWriteFile(
        'app/page.tsx',
        `import HabitList from './components/HabitList';

export default function Home() {
  return (
    <main>
      <h1>Habit tracker, hot reloaded</h1>
      <HabitList />
    </main>
  );
}
`,
      ),
    );
    await expect(app.getByRole('heading', { name: 'Habit tracker, hot reloaded' })).toBeVisible({ timeout: 60_000 });
    expect(await app.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('still here');
  },
} satisfies Checks;
