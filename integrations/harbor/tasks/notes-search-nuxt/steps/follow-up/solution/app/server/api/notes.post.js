import db from '../db.js';

export default defineEventHandler(async (event) => {
  const input = (await readBody(event)) || {};
  const title = String(input.title ?? '').trim().slice(0, 200);
  const body = String(input.body ?? '').trim().slice(0, 10000);
  if (!title && !body) {
    throw createError({ statusCode: 400, statusMessage: 'A note needs a title or a body.' });
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notes (title, body) VALUES (?, ?)')
    .run(title, body);
  const note = db
    .prepare('SELECT id, title, body, pinned, created_at FROM notes WHERE id = ?')
    .get(Number(lastInsertRowid));
  return { ...note, pinned: Boolean(note.pinned) };
});
