'use server';

import { revalidatePath } from 'next/cache';
import { insertNote, setPinned } from '../lib/db.js';

export async function addNote(formData) {
  const title = String(formData.get('title') ?? '').trim().slice(0, 200);
  const body = String(formData.get('body') ?? '').trim().slice(0, 10000);
  if (!title && !body) {
    return { ok: false, error: 'Write a title or a body before saving.' };
  }
  insertNote(title, body);
  revalidatePath('/');
  return { ok: true };
}

export async function setNotePinned(id, pinned) {
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) {
    return { ok: false };
  }
  const ok = setPinned(noteId, Boolean(pinned));
  revalidatePath('/');
  return { ok };
}
