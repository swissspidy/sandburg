'use server';

import db, { listTasks, priorityToNumber } from '../lib/db.js';

export async function getTasks() {
  return listTasks();
}

export async function addTask(text, priority) {
  const clean = String(text ?? '').trim().slice(0, 500);
  if (clean) {
    db.prepare('INSERT INTO tasks (text, priority) VALUES (?, ?)').run(
      clean,
      priorityToNumber(priority)
    );
  }
  return listTasks();
}

export async function setTaskDone(id, done) {
  db.prepare('UPDATE tasks SET done = ? WHERE id = ?').run(done ? 1 : 0, Number(id));
  return listTasks();
}

export async function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id));
  return listTasks();
}
