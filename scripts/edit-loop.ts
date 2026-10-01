/**
 * Edit-to-render latency: runs a fixture, edits one of its files five times while it runs (as
 * `sandburg open` and hot-reload checks do), and times each edit until the new text renders.
 *
 *   node scripts/edit-loop.ts [vite-react,svelte,next,angular]
 *
 * See ADR 0017 for the measurements.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Session, type Checks } from '../src/index.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The text `from` in `file` is edited; `shown` is how it renders when it differs (a binding). */
const CASES: Record<string, { fixture: string; file: string; from: string; shown?: string }> = {
  'vite-react': { fixture: 'fixtures/vite-react-counter', file: 'src/App.tsx', from: 'Counter and todos' },
  svelte: { fixture: 'fixtures/svelte-vite', file: 'src/App.svelte', from: 'Get started' },
  next: { fixture: 'fixtures/next-app-router', file: 'app/page.tsx', from: 'Habit tracker' },
  angular: { fixture: 'fixtures/angular-tasks', file: 'src/app/app.html', from: '{{ title }}', shown: 'Task board' },
};

const names = (process.argv[2] ?? Object.keys(CASES).join(',')).split(',');
const session = new Session();
await session.open();
try {
  for (const name of names) {
    const c = CASES[name];
    if (!c) throw new Error(`unknown case ${name} (${Object.keys(CASES).join(', ')})`);
    const original = await readFile(`${ROOT}${c.fixture}/${c.file}`, 'utf8');
    const times: number[] = [];
    const checks: Checks = {
      edits: async ({ app, page }) => {
        await app.getByText(c.shown ?? c.from).first().waitFor({ timeout: 60_000 });
        for (let i = 1; i <= 5; i++) {
          const t = performance.now();
          await page.evaluate(([path, content]) => (window as unknown as { __sandburgWriteFile(p: string, c: string): void }).__sandburgWriteFile(path, content), [c.file, original.replace(c.from, `${c.from} edit ${i}`)] as const);
          await app.getByText(`${c.shown ?? c.from} edit ${i}`).first().waitFor({ timeout: 60_000 });
          times.push(Math.round(performance.now() - t));
        }
      },
    };
    const r = await session.run(`${ROOT}${c.fixture}`, { checks });
    console.log(`${name.padEnd(10)} ${r.status}  edit to render (ms): ${times.join(', ')}${r.failure ? `  ${r.failure.message.slice(0, 200)}` : ''}`);
  }
} finally {
  await session.close();
}
