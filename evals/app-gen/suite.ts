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
  /**
   * The visitor's next request, once the app passes its checks. The app then runs again with the
   * database its checks left behind (in a fresh browser), so these checks see that data only if it
   * came through the change.
   */
  followUp?: { prompt: string; checks: Checks };
}

/** Load the app again with its browser storage cleared: what is still there came from the backend. */
async function reloadFresh({ app, appUrl }: Parameters<Checks[string]>[0]): Promise<void> {
  // A person does not reload the instant the page has changed: a save still on its way would be cut off.
  await app.waitForTimeout(1000);
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
        await app.getByLabel('New task', { exact: true }).fill('Buy milk');
        await app.getByRole('button', { name: 'Add', exact: true }).click();
        // Wait as a person would: the app may clear the field when the task is saved.
        await expect(app.getByRole('list', { name: 'Tasks' })).toContainText('Buy milk');
        await app.getByLabel('New task', { exact: true }).fill('Walk the dog');
        await app.getByLabel('New task', { exact: true }).press('Enter');
        const items = app.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
        await expect(items).toHaveCount(2);
        await expect(items.first()).toContainText('Buy milk');
      },
      'marks a task done and deletes one': async ({ app, expect }) => {
        await app.getByRole('checkbox', { name: 'Buy milk' }).setChecked(true, { force: true });
        // At a person's pace: the toggle may still be saving (a SvelteKit form post) when the next action starts.
        await app.waitForTimeout(1000);
        await app.getByRole('button', { name: 'Delete Walk the dog' }).click();
        await expect(app.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveCount(1);
      },
      'tasks and their state come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByRole('checkbox', { name: 'Buy milk' })).toBeChecked();
        await ctx.expect(ctx.app.getByText('Walk the dog')).toHaveCount(0);
      },
    },
    followUp: {
      prompt: `Add a priority to tasks. Next to the "New task" field, a select labeled "Priority" with the options Low, Normal and High (Normal by default) sets the priority of the next task. Each task shows its priority as text: "High", "Normal" or "Low". Sort the list by priority, High first, and oldest first within a priority. Tasks that already exist keep their state and get Normal.`,
      checks: {
        'existing tasks keep their state and get Normal': async ({ app, expect }) => {
          const items = app.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
          await expect(items).toHaveCount(1);
          await expect(app.getByRole('checkbox', { name: 'Buy milk' })).toBeChecked();
          await expect(items.first()).toContainText('Normal');
        },
        'a high-priority task comes first': async ({ app, expect }) => {
          await app.getByLabel('Priority', { exact: true }).selectOption('High');
          await app.getByLabel('New task', { exact: true }).fill('Pay rent');
          await app.getByRole('button', { name: 'Add', exact: true }).click();
          const items = app.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
          await expect(items).toHaveCount(2);
          await expect(items.first()).toContainText('Pay rent');
          await expect(items.first()).toContainText('High');
        },
        'priorities come from the database': async (ctx) => {
          await reloadFresh(ctx);
          const items = ctx.app.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
          await ctx.expect(items).toHaveCount(2);
          await ctx.expect(items.first()).toContainText('Pay rent');
          await ctx.expect(items.first()).toContainText('High');
        },
      },
    },
  },
  {
    id: 'tip-calculator',
    prompt: `A tip calculator. Number fields labeled "Bill amount" and "Tip percent", and "People" (default 1). As the visitor types, it shows "Tip: $X.XX", "Total: $X.XX" and "Per person: $X.XX", with two decimals. No backend needed for this one.`,
    checks: {
      'computes tip and total': async ({ app, expect }) => {
        await app.getByLabel('Bill amount', { exact: true }).fill('80');
        await app.getByLabel('Tip percent', { exact: true }).fill('15');
        await expect(app.locator('body')).toContainText(/Tip:\s*\$12\.00/);
        await expect(app.locator('body')).toContainText(/Total:\s*\$92\.00/);
      },
      'splits between people': async ({ app, expect }) => {
        await app.getByLabel('People', { exact: true }).fill('4');
        await expect(app.locator('body')).toContainText(/Per person:\s*\$23\.00/);
      },
    },
    followUp: {
      prompt: `Add a checkbox labeled "Round up". When it is checked, the total is rounded up to the next whole dollar and the tip grows to match. "Per person" divides the rounded total.`,
      checks: {
        'rounds the total up': async ({ app, expect }) => {
          await app.getByLabel('Bill amount', { exact: true }).fill('81');
          await app.getByLabel('Tip percent', { exact: true }).fill('15');
          await expect(app.locator('body')).toContainText(/Total:\s*\$93\.15/);
          // A styled checkbox often draws a box over the input: a person clicks the box, which toggles it.
          // By role, so a description inside the label ("Round up: to the next dollar") still matches.
          await app.getByRole('checkbox', { name: /^Round up\b/ }).setChecked(true, { force: true });
          await expect(app.locator('body')).toContainText(/Total:\s*\$94\.00/);
          await expect(app.locator('body')).toContainText(/Tip:\s*\$13\.00/);
        },
        'splits the rounded total': async ({ app, expect }) => {
          await app.getByLabel('People', { exact: true }).fill('2');
          await expect(app.locator('body')).toContainText(/Per person:\s*\$47\.00/);
        },
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
          await app.getByLabel('Name', { exact: true }).fill(name);
          await app.getByLabel('Message', { exact: true }).fill(message);
          await app.getByRole('button', { name: 'Sign' }).click();
          await expect(app.getByRole('list', { name: 'Entries' })).toContainText(message);
        }
        const items = app.getByRole('list', { name: 'Entries' }).getByRole('listitem');
        await expect(items).toHaveCount(2);
        await expect(items.first()).toContainText('Grace');
        await expect(items.first()).toContainText('Hello from the Navy');
      },
      'an empty message is refused': async ({ app, expect }) => {
        await app.getByLabel('Name', { exact: true }).fill('Nobody');
        await app.getByLabel('Message', { exact: true }).fill('');
        await app.getByRole('button', { name: 'Sign' }).click();
        await expect(app.getByRole('alert')).toBeVisible();
        await expect(app.getByRole('list', { name: 'Entries' }).getByRole('listitem')).toHaveCount(2);
      },
      'entries come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByRole('list', { name: 'Entries' }).getByRole('listitem')).toHaveCount(2);
      },
    },
    followUp: {
      prompt: `Add likes. Each entry has a button "Like <name>'s message" (for example "Like Ada's message") and shows how many likes it has, as "1 like" or "N likes" ("0 likes" before any). Store likes in the database. Entries that already exist start with 0 likes.`,
      checks: {
        'existing entries are still there, with 0 likes': async ({ app, expect }) => {
          const items = app.getByRole('list', { name: 'Entries' }).getByRole('listitem');
          await expect(items).toHaveCount(2);
          await expect(items.first()).toContainText('Grace');
          await expect(items.filter({ hasText: 'Ada' })).toContainText(/(?<!\d)0 likes\b/);
        },
        'likes count up': async ({ app, expect }) => {
          const ada = app.getByRole('list', { name: 'Entries' }).getByRole('listitem').filter({ hasText: 'Ada' });
          await app.getByRole('button', { name: "Like Ada's message" }).click();
          await expect(ada).toContainText(/(?<!\d)1 like\b(?!s)/);
          await app.getByRole('button', { name: "Like Ada's message" }).click();
          await expect(ada).toContainText(/(?<!\d)2 likes\b/);
        },
        'likes come from the database': async (ctx) => {
          await reloadFresh(ctx);
          const items = ctx.app.getByRole('list', { name: 'Entries' }).getByRole('listitem');
          await ctx.expect(items.filter({ hasText: 'Ada' })).toContainText(/(?<!\d)2 likes\b/);
          await ctx.expect(items.filter({ hasText: 'Grace' })).toContainText(/(?<!\d)0 likes\b/);
        },
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
          await app.getByLabel('Title', { exact: true }).fill(title);
          await app.getByLabel('Body', { exact: true }).fill(body);
          await app.getByRole('button', { name: 'Save note' }).click();
          await expect(app.getByRole('list', { name: 'Notes' })).toContainText(title);
        }
        await expect(app.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(3);
      },
      'search matches title or body, ignoring case': async ({ app, expect }) => {
        const items = app.getByRole('list', { name: 'Notes' }).getByRole('listitem');
        await app.getByLabel('Search', { exact: true }).fill('EGGS');
        await expect(items).toHaveCount(2);
        await app.getByLabel('Search', { exact: true }).fill('trip');
        await expect(items).toHaveCount(1);
        await app.getByLabel('Search', { exact: true }).fill('');
        await expect(items).toHaveCount(3);
      },
      'notes come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(3);
      },
    },
    followUp: {
      prompt: `Add pinning. Each note has a button "Pin <title>" (for example "Pin Trip"), which becomes "Unpin <title>" once the note is pinned. Pinned notes come first in the list, then the others, each in the order they had before. Store the pinned state in the database. Notes that already exist start unpinned.`,
      checks: {
        'existing notes are still there, unpinned': async ({ app, expect }) => {
          await expect(app.getByRole('list', { name: 'Notes' }).getByRole('listitem')).toHaveCount(3);
          await expect(app.getByRole('button', { name: 'Pin Trip', exact: true })).toBeVisible();
        },
        'pinning moves a note to the top': async ({ app, expect }) => {
          // Trip was saved second: it is in the middle whether the list is oldest or newest first.
          await app.getByRole('button', { name: 'Pin Trip', exact: true }).click();
          await expect(app.getByRole('button', { name: 'Unpin Trip', exact: true })).toBeVisible();
          await expect(app.getByRole('list', { name: 'Notes' }).getByRole('listitem').first()).toContainText('Trip');
        },
        'pins come from the database': async (ctx) => {
          await reloadFresh(ctx);
          await ctx.expect(ctx.app.getByRole('list', { name: 'Notes' }).getByRole('listitem').first()).toContainText('Trip');
          await ctx.expect(ctx.app.getByRole('button', { name: 'Unpin Trip', exact: true })).toBeVisible();
        },
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
          await app.getByLabel('Description', { exact: true }).fill(d);
          await app.getByLabel('Amount', { exact: true }).fill(a);
          await app.getByRole('button', { name: 'Add expense' }).click();
          await expect(app.getByRole('list', { name: 'Expenses' })).toContainText(d);
        }
        await expect(app.locator('body')).toContainText(/Total:\s*\$35\.75/);
      },
      'removing an expense updates the total': async ({ app, expect }) => {
        await app.getByRole('button', { name: 'Remove Lunch' }).click();
        await expect(app.locator('body')).toContainText(/Total:\s*\$23\.50/);
      },
      'expenses come from the database': async (ctx) => {
        await reloadFresh(ctx);
        await ctx.expect(ctx.app.locator('body')).toContainText(/Total:\s*\$23\.50/);
      },
    },
    followUp: {
      prompt: `Add categories. A select labeled "Category" with Food, Transport and Other (Other by default) sets the category of the next expense, and each expense shows its category. Below the total, show one line per category that has expenses, as "Food: $X.XX". Expenses that already exist get Other.`,
      checks: {
        'existing expenses get Other': async ({ app, expect }) => {
          await expect(app.locator('body')).toContainText(/Total:\s*\$23\.50/);
          await expect(app.locator('body')).toContainText(/Other:\s*\$23\.50/);
        },
        'a new expense counts in its category': async ({ app, expect }) => {
          await app.getByLabel('Category', { exact: true }).selectOption('Transport');
          await app.getByLabel('Description', { exact: true }).fill('Bus');
          await app.getByLabel('Amount', { exact: true }).fill('2.75');
          await app.getByRole('button', { name: 'Add expense' }).click();
          await expect(app.getByRole('list', { name: 'Expenses' })).toContainText('Bus');
          await expect(app.locator('body')).toContainText(/Total:\s*\$26\.25/);
          await expect(app.locator('body')).toContainText(/Transport:\s*\$2\.75/);
        },
        'categories come from the database': async (ctx) => {
          await reloadFresh(ctx);
          await ctx.expect(ctx.app.locator('body')).toContainText(/Transport:\s*\$2\.75/);
          await ctx.expect(ctx.app.locator('body')).toContainText(/Other:\s*\$23\.50/);
        },
      },
    },
  },
];
