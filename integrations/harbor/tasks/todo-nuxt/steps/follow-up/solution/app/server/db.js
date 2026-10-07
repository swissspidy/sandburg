import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: priority column (0 = low, 1 = normal, 2 = high). Existing rows get normal.
const columns = db.prepare('PRAGMA table_info(tasks)').all();
if (!columns.some((c) => c.name === 'priority')) {
  db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');
}

export const PRIORITIES = ['low', 'normal', 'high'];

export function priorityToNumber(value) {
  const index = PRIORITIES.indexOf(value);
  return index === -1 ? null : index;
}

export function toTask(row) {
  return {
    id: Number(row.id),
    text: row.text,
    done: Boolean(row.done),
    priority: PRIORITIES[Number(row.priority)] ?? 'normal',
  };
}

export default db;
