import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    priority INTEGER NOT NULL DEFAULT 1
  )
`);

// Migration: older databases have no priority column; existing tasks become Normal (1).
const columns = db.prepare('PRAGMA table_info(tasks)').all();
if (!columns.some((c) => c.name === 'priority')) {
  db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');
}

export default db;
