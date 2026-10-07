import db from '../db.js';

export default defineEventHandler(() => {
  return db
    .prepare('SELECT id, name, message, created_at, likes FROM entries ORDER BY id DESC')
    .all();
});
