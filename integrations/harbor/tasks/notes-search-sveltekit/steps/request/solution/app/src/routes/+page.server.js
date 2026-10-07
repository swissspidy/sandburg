import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

export function load() {
  const notes = db
    .prepare('SELECT id, title, body, created_at FROM notes ORDER BY id DESC')
    .all()
    .map((n) => ({ id: Number(n.id), title: n.title, body: n.body, created_at: n.created_at }));
  return { notes };
}

export const actions = {
  create: async ({ request }) => {
    const form = await request.formData();
    const title = String(form.get('title') ?? '').trim();
    const body = String(form.get('body') ?? '').trim();
    if (!title) {
      return fail(400, { error: 'Please give your note a title.', title, body });
    }
    if (title.length > 200) {
      return fail(400, { error: 'Title must be 200 characters or fewer.', title, body });
    }
    db.prepare('INSERT INTO notes (title, body) VALUES (?, ?)').run(title, body);
    return { success: true };
  },
  delete: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!Number.isInteger(id)) return fail(400, { error: 'Invalid note.' });
    db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return { deleted: true };
  }
};
