import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

export function load() {
  const tasks = db
    .prepare('SELECT id, text, done FROM tasks ORDER BY id ASC')
    .all()
    .map((t) => ({ id: Number(t.id), text: t.text, done: Boolean(t.done) }));
  return { tasks };
}

export const actions = {
  add: async ({ request }) => {
    const form = await request.formData();
    const text = String(form.get('text') ?? '').trim();
    if (!text) return fail(400, { error: 'Please enter a task.' });
    if (text.length > 500) return fail(400, { error: 'Task is too long (max 500 characters).', text });
    db.prepare('INSERT INTO tasks (text) VALUES (?)').run(text);
    return { success: true };
  },

  toggle: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!Number.isInteger(id)) return fail(400, { error: 'Invalid task.' });
    const done = form.get('done') ? 1 : 0;
    db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(done, id);
    return { success: true };
  },

  delete: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!Number.isInteger(id)) return fail(400, { error: 'Invalid task.' });
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { success: true };
  }
};
