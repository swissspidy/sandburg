import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: databases created before priorities existed get the column (Normal = 1).
const columns = db.prepare('PRAGMA table_info(tasks)').all();
if (!columns.some((c) => c.name === 'priority')) {
  db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');
}

// 0 = Low, 1 = Normal, 2 = High
export const PRIORITIES = ['low', 'normal', 'high'];

export function priorityToNumber(value) {
  const index = PRIORITIES.indexOf(String(value ?? '').toLowerCase());
  return index === -1 ? 1 : index;
}

export function listTasks() {
  return db
    .prepare('SELECT id, text, done, priority FROM tasks ORDER BY priority DESC, id ASC')
    .all()
    .map((row) => ({
      id: Number(row.id),
      text: String(row.text),
      done: Boolean(row.done),
      priority: PRIORITIES[Number(row.priority)] ?? 'normal',
    }));
}

export default db;
