import db, { toTask, priorityToNumber } from '../db.js';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw createError({ statusCode: 400, statusMessage: 'Task text is required' });
  }
  if (text.length > 500) {
    throw createError({ statusCode: 400, statusMessage: 'Task text is too long' });
  }
  const priority = body?.priority === undefined ? 1 : priorityToNumber(body.priority);
  if (priority === null) {
    throw createError({ statusCode: 400, statusMessage: 'Priority must be low, normal or high' });
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO tasks (text, priority) VALUES (?, ?)')
    .run(text, priority);
  const row = db
    .prepare('SELECT id, text, done, priority FROM tasks WHERE id = ?')
    .get(lastInsertRowid);
  return toTask(row);
});
