import db from '../../db.js';

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'));
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' });
  }
  const input = (await readBody(event)) || {};
  if (typeof input.pinned !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'pinned must be true or false' });
  }
  const { changes } = db
    .prepare('UPDATE notes SET pinned = ? WHERE id = ?')
    .run(input.pinned ? 1 : 0, id);
  if (!changes) {
    throw createError({ statusCode: 404, statusMessage: 'Note not found' });
  }
  const note = db
    .prepare('SELECT id, title, body, pinned, created_at FROM notes WHERE id = ?')
    .get(id);
  return { ...note, pinned: Boolean(note.pinned) };
});
