import { useEffect, useRef, useState } from 'react';

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    api('/api/tasks')
      .then(setTasks)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function addTask(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || adding) return;
    setAdding(true);
    setError('');
    try {
      const task = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ text: value }) });
      setTasks((t) => [...t, task]);
      setText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  }

  async function toggleTask(task) {
    const done = !task.done;
    setTasks((t) => t.map((x) => (x.id === task.id ? { ...x, done } : x)));
    try {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    } catch (err) {
      setTasks((t) => t.map((x) => (x.id === task.id ? { ...x, done: task.done } : x)));
      setError(err.message);
    }
  }

  async function deleteTask(task) {
    const previous = tasks;
    setTasks((t) => t.filter((x) => x.id !== task.id));
    try {
      await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    } catch (err) {
      setTasks(previous);
      setError(err.message);
    }
  }

  const doneCount = tasks.filter((t) => t.done).length;

  return (
    <main className="page">
      <section className="card">
        <header className="card-header">
          <h1>To-do</h1>
          {tasks.length > 0 && (
            <p className="count">
              {doneCount} of {tasks.length} done
            </p>
          )}
        </header>

        <form className="add-form" onSubmit={addTask}>
          <label htmlFor="new-task" className="visually-hidden">
            New task
          </label>
          <input
            id="new-task"
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What needs doing?"
            maxLength={500}
            autoComplete="off"
          />
          <button type="submit" className="add-btn" disabled={!text.trim() || adding}>
            Add
          </button>
        </form>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="empty">Loading tasks…</p>
        ) : (
          <>
            <ul className="tasks" aria-label="Tasks">
              {tasks.map((task) => (
                <li key={task.id} className={task.done ? 'task done' : 'task'}>
                  <label className="task-label">
                    <input type="checkbox" checked={task.done} onChange={() => toggleTask(task)} />
                    <span className="task-text">{task.text}</span>
                  </label>
                  <button
                    type="button"
                    className="delete-btn"
                    aria-label={`Delete ${task.text}`}
                    title="Delete"
                    onClick={() => deleteTask(task)}
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
            {tasks.length === 0 && (
              <div className="empty">
                <span className="empty-icon" aria-hidden="true">📝</span>
                <p>No tasks yet. Add your first one above.</p>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
