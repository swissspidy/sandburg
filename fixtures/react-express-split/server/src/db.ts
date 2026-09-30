import { DatabaseSync } from 'node:sqlite';

export interface Bookmark {
  id: number;
  title: string;
  url: string;
}

export const db = new DatabaseSync('bookmarks.sqlite');
db.exec(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE
  )
`);
