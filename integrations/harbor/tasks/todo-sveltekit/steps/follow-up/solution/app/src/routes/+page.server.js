import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

const PRIORITY_VALUES = { low: 0, normal: 1, high: 2 };
const PRIORITY_NAMES = ['low', 'normal', 'high'];

export function load() {
  const tasks = db
    .prepare('SELECT id, text, done, priority FROM tasks ORDER BY priority DESC, id ASC')
    .all()
    .map((t) => ({
      id: Number(t.id),
      text: t.text,
      done: Boolean(t.done),
      priority: PRIORITY_NAMES[Number(t.priority)] ?? 'normal'
    }));
  return { tasks };
}

export const actions = {
  add: async ({ request }) => {
    const form = await request.formData();
    const text = String(form.get('text') ?? '').trim();
    const priorityName = String(form.get('priority') ?? 'normal');
    const priority = PRIORITY_VALUES[priorityName];
    if (priority === undefined) return fail(400, { error: 'Invalid priority.', text, priority: 'normal' });
    if (!text) return fail(400, { error: 'Please enter a task.', priority: priorityName });
    if (text.length > 500)
      return fail(400, { error: 'Task is too long (max 500 characters).', text, priority: priorityName });
    db.prepare('INSERT INTO tasks (text, priority) VALUES (?, ?)').run(text, priority);
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
