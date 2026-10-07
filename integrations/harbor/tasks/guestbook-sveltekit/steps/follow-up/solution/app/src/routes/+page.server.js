import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

export function load() {
  const entries = db
    .prepare('SELECT id, name, message, created_at, likes FROM entries ORDER BY id DESC')
    .all()
    .map((e) => ({ ...e }));
  return { entries };
}

export const actions = {
  sign: async ({ request }) => {
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim().slice(0, 60);
    const message = String(form.get('message') ?? '').trim().slice(0, 500);

    if (!message) {
      return fail(400, { error: 'Please write a message before signing.', name, message });
    }

    db.prepare('INSERT INTO entries (name, message) VALUES (?, ?)').run(name || 'Anonymous', message);
    return { success: true };
  },

  like: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return fail(400, { likeError: 'Invalid entry.' });
    }
    const result = db.prepare('UPDATE entries SET likes = likes + 1 WHERE id = ?').run(id);
    if (result.changes === 0) {
      return fail(404, { likeError: 'Entry not found.' });
    }
    return { liked: id };
  }
};
