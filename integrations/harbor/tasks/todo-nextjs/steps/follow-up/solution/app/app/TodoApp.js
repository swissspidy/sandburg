'use client';

import { useRef, useState, useTransition } from 'react';
import { addTask, setTaskDone, deleteTask } from './actions.js';

const PRIORITY_LABELS = { high: 'High', normal: 'Normal', low: 'Low' };

export default function TodoApp({ initialTasks }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('normal');
  const [error, setError] = useState('');
  const [, startTransition] = useTransition();
  const inputRef = useRef(null);

  function run(optimistic, action) {
    const previous = tasks;
    if (optimistic) setTasks(optimistic);
    setError('');
    startTransition(async () => {
      try {
        const next = await action();
        setTasks(next);
      } catch {
        setTasks(previous);
        setError('Something went wrong. Please try again.');
      }
    });
  }

  function handleSubmit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value) {
      inputRef.current?.focus();
      return;
    }
    setText('');
    const chosen = priority;
    run(null, () => addTask(value, chosen));
    inputRef.current?.focus();
  }

  const remaining = tasks.filter((t) => !t.done).length;

  return (
    <section className="card">
      <form className="add-form" onSubmit={handleSubmit}>
        <label htmlFor="new-task" className="sr-only">
          New task
        </label>
        <input
          id="new-task"
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What needs doing?"
          autoComplete="off"
          maxLength={500}
        />
        <div className="form-controls">
          <label htmlFor="new-priority" className="sr-only">
            Priority
          </label>
          <select
            id="new-priority"
            className="priority-select"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <button type="submit" className="add-btn">
            Add
          </button>
        </div>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <ul className="task-list" aria-label="Tasks">
        {tasks.map((task) => (
          <li key={task.id} className={task.done ? 'task done' : 'task'}>
            <label className="task-label">
              <input
                type="checkbox"
                checked={task.done}
                onChange={(e) => {
                  const done = e.target.checked;
                  run(
                    tasks.map((t) => (t.id === task.id ? { ...t, done } : t)),
                    () => setTaskDone(task.id, done)
                  );
                }}
              />
              <span className="task-text">{task.text}</span>
            </label>
            <span className={`priority-badge priority-${task.priority}`}>
              {PRIORITY_LABELS[task.priority] ?? 'Normal'}
            </span>
            <button
              type="button"
              className="delete-btn"
              aria-label={`Delete ${task.text}`}
              title="Delete"
              onClick={() =>
                run(
                  tasks.filter((t) => t.id !== task.id),
                  () => deleteTask(task.id)
                )
              }
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {tasks.length === 0 ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">📝</span>
          <p>No tasks yet. Add your first one above.</p>
        </div>
      ) : (
        <p className="summary" aria-live="polite">
          {remaining === 0
            ? 'All done! 🎉'
            : `${remaining} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} left`}
        </p>
      )}
    </section>
  );
}
