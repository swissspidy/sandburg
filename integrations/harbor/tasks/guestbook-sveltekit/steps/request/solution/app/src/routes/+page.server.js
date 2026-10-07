import { fail } from '@sveltejs/kit';
import db from '$lib/server/db.js';

export function load() {
  const entries = db
    .prepare('SELECT id, name, message, created_at FROM entries ORDER BY id DESC')
    .all()
    .map((e) => ({ ...e }));
  return { entries };
}

export const actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim().slice(0, 60);
    const message = String(form.get('message') ?? '').trim().slice(0, 500);

    if (!message) {
      return fail(400, { error: 'Please write a message before signing.', name, message });
    }

    db.prepare('INSERT INTO entries (name, message) VALUES (?, ?)').run(name || 'Anonymous', message);
    return { success: true };
  }
};
