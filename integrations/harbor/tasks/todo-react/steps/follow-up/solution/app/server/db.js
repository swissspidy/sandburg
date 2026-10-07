import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrate databases created before priorities existed: existing tasks become Normal.
const columns = db.prepare('PRAGMA table_info(tasks)').all();
if (!columns.some((c) => c.name === 'priority')) {
  db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
}

export default db;
