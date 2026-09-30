import Database from 'better-sqlite3';

const db = new Database('notes.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const count = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
if (count === 0) {
  const insert = db.prepare('INSERT INTO notes (text, pinned) VALUES (@text, @pinned)');
  const seed = db.transaction((notes) => {
    for (const note of notes) insert.run(note);
  });
  seed([
    { text: 'Buy oat milk', pinned: 0 },
    { text: 'Call the plumber', pinned: 1 },
  ]);
}

export default db;
