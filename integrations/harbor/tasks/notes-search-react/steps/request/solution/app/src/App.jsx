import { useEffect, useMemo, useState } from 'react';

function formatDate(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
    if (!q) return notes;
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
    );
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

  async function handleDelete(id) {
    setError('');
    const r = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (r.ok || r.status === 404) {
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } else {
      setError('Could not delete the note.');
    }
  }

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
            {filtered.map((note) => (
              <li key={note.id} className="card note">
                <div className="note-head">
                  <h3>{note.title || <em className="untitled">Untitled</em>}</h3>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleDelete(note.id)}
                    aria-label={`Delete note ${note.title || 'Untitled'}`}
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
                {note.body && <p className="note-body">{note.body}</p>}
                <time className="note-date" dateTime={note.created_at}>
                  {formatDate(note.created_at)}
                </time>
              </li>
            ))}
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
