import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export default db;
