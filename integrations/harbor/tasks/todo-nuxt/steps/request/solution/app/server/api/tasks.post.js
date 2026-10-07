import db, { toTask } from '../db.js';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw createError({ statusCode: 400, statusMessage: 'Task text is required' });
  }
  if (text.length > 500) {
    throw createError({ statusCode: 400, statusMessage: 'Task text is too long' });
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO tasks (text) VALUES (?)').run(text);
  const row = db.prepare('SELECT id, text, done FROM tasks WHERE id = ?').get(lastInsertRowid);
  return toTask(row);
});
