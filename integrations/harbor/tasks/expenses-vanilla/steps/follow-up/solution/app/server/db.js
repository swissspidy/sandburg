import { DatabaseSync } from 'node:sqlite';

// The app's database: a file next to the project (exec, prepare(sql).all/get/run).
const db = new DatabaseSync('app.db');

export const CATEGORIES = ['Food', 'Transport', 'Other'];

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'Other',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrate older databases: existing expenses get the "Other" category.
const columns = db.prepare('PRAGMA table_info(expenses)').all();
if (!columns.some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'");
}

export default db;
