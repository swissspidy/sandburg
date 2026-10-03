/**
 * The app-generation suite: each task is a request as a visitor would type it on the generator page,
 * plus the accessible names the checks use, and Playwright checks that the app does what was asked.
 * The checks run in task order against one app, so later checks may rely on earlier ones.
 */
import type { Checks } from '../../src/index.ts';

export interface Task {
  id: string;
  prompt: string;
  checks: Checks;
}

/** Load the app again with its browser storage cleared: what is still there came from the backend. */
async function reloadFresh({ app, appUrl }: Parameters<Checks[string]>[0]): Promise<void> {
  await app.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await app.goto(appUrl('/'));
}

export const SUITE: Task[] = [
  {
    id: 'todo',
    prompt: `A to-do app. A text field labeled "New task" and an "Add" button add a task (Enter in the field adds it too). Tasks are listed in a list labeled "Tasks", oldest first. Each task has a checkbox labeled with the task's text to mark it done, and a button "Delete <task text>" to remove it. Store tasks in the database.`,
    checks: {
      'adds tasks': async ({ app, expect }) => {
        await app.getByLabel('New task').fill('Buy milk');
        await app.getByRole('button', { name: 'Add', exact: true }).click();
        // Wait as a person would: the app may clear the field when the task is saved.
        await expect(app.getByRole('list', { name: 'Tasks' })).toContainText('Buy milk');
        await app.getByLabel('New task').fill('Walk the dog');
        await app.getByLabel('New task').press('Enter');
        const items = app.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
        await expect(items).toHaveCount(2);
        await expect(items.first()).toContainText('Buy milk');
      },
      'marks a task done and deletes one': async ({ app, expect }) => {
        await app.getByRole('checkbox', { name: 'Buy milk' }).check();
        await app.getByRole('button', { name: 'Delete Walk the dog' }).click();
        await expect(app.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveCount(1);
      },
      'tasks and their state come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByRole('checkbox', { name: 'Buy milk' })).toBeChecked();
        await ctx.expect(ctx.app.getByText('Walk the dog')).toHaveCount(0);
      },
    },
  },
  {
    id: 'tip-calculator',
    prompt: `A tip calculator. Number fields labeled "Bill amount" and "Tip percent", and "People" (default 1). As the visitor types, it shows "Tip: $X.XX", "Total: $X.XX" and "Per person: $X.XX", with two decimals. No backend needed for this one.`,
    checks: {
      'computes tip and total': async ({ app, expect }) => {
        await app.getByLabel('Bill amount').fill('80');
        await app.getByLabel('Tip percent').fill('15');
        await expect(app.getByText('Tip: $12.00')).toBeVisible();
        await expect(app.getByText('Total: $92.00')).toBeVisible();
      },
      'splits between people': async ({ app, expect }) => {
        await app.getByLabel('People').fill('4');
        await expect(app.getByText('Per person: $23.00')).toBeVisible();
      },
    },
  },
  {
    id: 'guestbook',
    prompt: `A guestbook. A form with fields labeled "Name" and "Message" and a "Sign" button. Entries are listed in a list labeled "Entries", newest first, each showing the name and the message. Signing with an empty message shows an error with role="alert" and adds nothing. Store entries in the database.`,
    checks: {
      'signs the guestbook, newest first': async ({ app, expect }) => {
        for (const [name, message] of [
          ['Ada', 'Lovely site'],
          ['Grace', 'Hello from the Navy'],
        ]) {
          await app.getByLabel('Name').fill(name);
          await app.getByLabel('Message').fill(message);
          await app.getByRole('button', { name: 'Sign' }).click();
          await expect(app.getByRole('list', { name: 'Entries' })).toContainText(message);
        }
        const items = app.getByRole('list', { name: 'Entries' }).getByRole('listitem');
        await expect(items).toHaveCount(2);
        await expect(items.first()).toContainText('Grace');
        await expect(items.first()).toContainText('Hello from the Navy');
      },
      'an empty message is refused': async ({ app, expect }) => {
        await app.getByLabel('Name').fill('Nobody');
        await app.getByLabel('Message').fill('');
        await app.getByRole('button', { name: 'Sign' }).click();
        await expect(app.getByRole('alert')).toBeVisible();
        await expect(app.getByRole('list', { name: 'Entries' }).getByRole('listitem')).toHaveCount(2);
      },
      'entries come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByRole('list', { name: 'Entries' }).getByRole('listitem')).toHaveCount(2);
      },
    },
  },
  {
    id: 'notes-search',
    prompt: `A notes app. Fields labeled "Title" and "Body" and a "Save note" button add a note. Notes are listed in a list labeled "Notes", one list item per note, showing title and body. A search field labeled "Search" filters the list as the visitor types, matching title or body, case-insensitively. Store notes in the database.`,
    checks: {
      'saves notes': async ({ app, expect }) => {
        for (const [title, body] of [
          ['Groceries', 'Eggs, flour, sugar'],
          ['Trip', 'Book the train to Zurich'],
          ['Recipe', 'Pancakes need eggs'],
        ]) {
          await app.getByLabel('Title').fill(title);
          await app.getByLabel('Body').fill(body);
          await app.getByRole('button', { name: 'Save note' }).click();
          await expect(app.getByRole('list', { name: 'Notes' })).toContainText(title);
        }
        await expect(app.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(3);
      },
      'search matches title or body, ignoring case': async ({ app, expect }) => {
        const items = app.getByRole('list', { name: 'Notes' }).getByRole('listitem');
        await app.getByLabel('Search').fill('EGGS');
        await expect(items).toHaveCount(2);
        await app.getByLabel('Search').fill('trip');
        await expect(items).toHaveCount(1);
        await app.getByLabel('Search').fill('');
        await expect(items).toHaveCount(3);
      },
      'notes come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(3);
      },
    },
  },
  {
    id: 'expenses',
    prompt: `An expense tracker. Fields labeled "Description" and "Amount" (a number in dollars) and an "Add expense" button. Expenses are listed in a list labeled "Expenses"; each has a button "Remove <description>". A line shows "Total: $X.XX" with two decimals, the sum of all expenses. Store expenses in the database.`,
    checks: {
      'adds expenses and sums them': async ({ app, expect }) => {
        for (const [d, a] of [
          ['Coffee', '3.50'],
          ['Lunch', '12.25'],
          ['Book', '20'],
        ]) {
          await app.getByLabel('Description').fill(d);
          await app.getByLabel('Amount').fill(a);
          await app.getByRole('button', { name: 'Add expense' }).click();
          await expect(app.getByRole('list', { name: 'Expenses' })).toContainText(d);
        }
        await expect(app.getByText('Total: $35.75')).toBeVisible();
      },
      'removing an expense updates the total': async ({ app, expect }) => {
        await app.getByRole('button', { name: 'Remove Lunch' }).click();
        await expect(app.getByText('Total: $23.50')).toBeVisible();
      },
      'expenses come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByText('Total: $23.50')).toBeVisible();
      },
    },
  },
];
