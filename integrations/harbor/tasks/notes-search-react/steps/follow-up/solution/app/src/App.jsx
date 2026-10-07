import { useEffect, useMemo, useState } from 'react';

function formatDate(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Pinned first, then the rest; within each group, newest first (the original order).
function byPinnedThenNewest(a, b) {
  return Number(b.pinned) - Number(a.pinned) || b.id - a.id;
}

export default function App() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/notes')
      .then((r) => {
        if (!r.ok) throw new Error('Could not load notes.');
        return r.json();
      })
      .then((data) => !cancelled && setNotes(data))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? notes.filter(
          (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
        )
      : notes;
    return [...matches].sort(byPinnedThenNewest);
  }, [notes, query]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim() && !body.trim()) {
      setError('Write a title or a body first.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not save the note.');
      setNotes((prev) => [data, ...prev]);
      setTitle('');
      setBody('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePin(note) {
    setError('');
    const pinned = !note.pinned;
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, pinned } : n)));
    try {
      const r = await fetch(`/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      if (!r.ok) throw new Error();
    } catch {
      setNotes((prev) =>
        prev.map((n) => (n.id === note.id ? { ...n, pinned: note.pinned } : n)),
      );
      setError('Could not update the note.');
    }
  }

  async function handleDelete(id) {
    setError('');
    const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (r.ok || r.status === 404) {
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } else {
      setError('Could not delete the note.');
    }
  }

  const pinnedCount = notes.filter((n) => n.pinned).length;

  return (
    <div className="page">
      <header className="header">
        <h1>
          <span aria-hidden="true">📝</span> Notes
        </h1>
        <p className="subtitle">Jot it down, find it later.</p>
      </header>

      <main className="layout">
        <section className="card composer" aria-labelledby="new-note-heading">
          <h2 id="new-note-heading">New note</h2>
          <form onSubmit={handleSubmit} noValidate>
            <label className="field">
              <span>Title</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Groceries"
                maxLength={200}
              />
            </label>
            <label className="field">
              <span>Body</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Milk, eggs, coffee…"
                rows={6}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </form>
        </section>

        <section className="notes-section" aria-labelledby="notes-heading">
          <div className="notes-top">
            <h2 id="notes-heading">
              All notes <span className="count">{notes.length}</span>
              {pinnedCount > 0 && (
                <span className="pinned-count">{pinnedCount} pinned</span>
              )}
            </h2>
            <label className="search">
              <span className="visually-hidden">Search</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
                <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                aria-label="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes"
              />
            </label>
          </div>

          <ul className="notes" aria-label="Notes">
            {filtered.map((note) => {
              const name = note.title || 'Untitled';
              return (
                <li key={note.id} className={`card note${note.pinned ? ' is-pinned' : ''}`}>
                  <div className="note-head">
                    <h3>{note.title || <em className="untitled">Untitled</em>}</h3>
                    <div className="note-actions">
                      <button
                        type="button"
                        className={`icon-btn pin-btn${note.pinned ? ' active' : ''}`}
                        onClick={() => handleTogglePin(note)}
                        aria-label={`${note.pinned ? 'Unpin' : 'Pin'} ${name}`}
                        title={note.pinned ? 'Unpin' : 'Pin'}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
                          <path
                            d="M9 4h6l-1 6 4 4H6l4-4-1-6zM12 14v6"
                            fill={note.pinned ? 'currentColor' : 'none'}
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="icon-btn delete-btn"
                        onClick={() => handleDelete(note.id)}
                        aria-label={`Delete note ${name}`}
                        title="Delete"
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
                          <path
                            d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {note.body && <p className="note-body">{note.body}</p>}
                  <div className="note-meta">
                    {note.pinned && <span className="pin-tag">Pinned</span>}
                    <time className="note-date" dateTime={note.created_at}>
                      {formatDate(note.created_at)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ul>

          {!loading && notes.length === 0 && (
            <div className="empty">
              <span aria-hidden="true">🗒️</span>
              <p>No notes yet. Write your first one!</p>
            </div>
          )}
          {!loading && notes.length > 0 && filtered.length === 0 && (
            <div className="empty">
              <span aria-hidden="true">🔍</span>
              <p>No notes match “{query.trim()}”.</p>
            </div>
          )}
          {loading && <p className="muted">Loading notes…</p>}
        </section>
      </main>
    </div>
  );
}
