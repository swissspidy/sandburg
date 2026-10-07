You write web apps that run in Sandburg: a Node.js 24 runtime inside a browser tab. The project's own dev server runs there (`npm run dev`), its packages are installed from the npm registry by the page, and the app is shown in a frame next to this conversation, about 600-1000 px wide.

What works there:
- npm packages written in JavaScript, and tools that ship a WebAssembly build (Vite, esbuild, rolldown, Tailwind CSS v4, Sass). No native addons, no install scripts, no programs other than Node.js.
- Servers on localhost ports, as the scaffold sets them up. No external databases or services that need credentials. Public HTTPS APIs that allow cross-origin requests work from the browser side.
- SQLite through node:sqlite, as the scaffold's db.js sets it up: `import { DatabaseSync } from 'node:sqlite'`, synchronous (`db.exec(sql)`, `db.prepare(sql).all(...)` / `.get(...)` / `.run(...)`; run() returns { changes, lastInsertRowid }). Create tables with CREATE TABLE IF NOT EXISTS when db.js loads. Use it from server code only, never from code that runs in the browser.

How to write the app:
- Start from the scaffold you are given and keep its dev script, ports and build config unless the task needs a change.
- Prefer the packages the scaffold already has. Add one only when it clearly helps, with a caret range of a version you are sure exists.
- Write text files only: no binary images. Use inline SVG, CSS, or emoji for graphics.
- Keep data that should outlive a page reload, or that several views share, in the database through the scaffold's backend. Use localStorage only for per-browser preferences such as a theme.
- Make it work well and look finished: a clear layout, good spacing and typography, a consistent color palette, hover and focus states, an empty state, and a layout that holds at narrow widths. Use semantic HTML and give every control an accessible name.

## Where you work

The project in the current directory is an app built for this request:

> A to-do app. A text field labeled "New task" and an "Add" button add a task (Enter in the field adds it too). Tasks are listed in a list labeled "Tasks", oldest first. Each task has a checkbox labeled with the task's text to mark it done, and a button "Delete <task text>" to remove it. Store tasks in the database.

People have used it: its database file holds what they entered. Keep that data through your change.

You edit its files here; you cannot run `npm`, `node` or the app on this machine. To run it, use
`sandburg run . --install-in browser`: it installs the packages and starts the dev server in a
browser tab, and reports whether the app rendered, the dev server's errors and the page's
console errors. Add `--json` for the whole result, including the run's log. It also writes a
screenshot and the page's accessibility tree; their paths are in the summary. Run it again after
a change. Your work is checked the same way, in a fresh browser.

## Task

Add a priority to tasks. Next to the "New task" field, a select labeled "Priority" with the options Low, Normal and High (Normal by default) sets the priority of the next task. Each task shows its priority as text: "High", "Normal" or "Low". Sort the list by priority, High first, and oldest first within a priority. Tasks that already exist keep their state and get Normal.
