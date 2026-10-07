import db, { toTask } from '../../db.js';

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'));
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' });
  }
  const body = await readBody(event);
  if (typeof body?.done !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: '"done" must be a boolean' });
  }
  const { changes } = db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(body.done ? 1 : 0, id);
  if (!changes) {
    throw createError({ statusCode: 404, statusMessage: 'Task not found' });
  }
  return toTask(db.prepare('SELECT id, text, done FROM tasks WHERE id = ?').get(id));
});
