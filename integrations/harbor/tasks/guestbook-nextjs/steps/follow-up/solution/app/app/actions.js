'use server';

import { revalidatePath } from 'next/cache';
import db from '../lib/db.js';

const MAX_NAME = 60;
const MAX_MESSAGE = 500;

export async function signGuestbook(prevState, formData) {
  const rawName = String(formData.get('name') ?? '');
  const rawMessage = String(formData.get('message') ?? '');
  const name = rawName.trim().slice(0, MAX_NAME);
  const message = rawMessage.trim();

  if (!message) {
    return {
      error: 'Please write a message before signing.',
      values: { name: rawName, message: rawMessage },
      ok: false,
    };
  }
  if (message.length > MAX_MESSAGE) {
    return {
      error: `Messages can be at most ${MAX_MESSAGE} characters.`,
      values: { name: rawName, message: rawMessage },
      ok: false,
    };
  }

  db.prepare('INSERT INTO entries (name, message) VALUES (?, ?)').run(
    name || 'Anonymous',
    message
  );
  revalidatePath('/');

  return { error: null, values: { name: '', message: '' }, ok: true, at: Date.now() };
}

export async function likeEntry(id) {
  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) return;
  db.prepare('UPDATE entries SET likes = likes + 1 WHERE id = ?').run(entryId);
  revalidatePath('/');
}
