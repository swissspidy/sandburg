import db, { toTask } from '../db.js';

export default defineEventHandler(() => {
  return db.prepare('SELECT id, text, done FROM tasks ORDER BY id ASC').all().map(toTask);
});
