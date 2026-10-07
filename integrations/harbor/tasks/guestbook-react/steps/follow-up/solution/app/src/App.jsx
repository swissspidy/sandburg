import { useEffect, useState } from 'react';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function likesLabel(n) {
  return `${n} ${n === 1 ? 'like' : 'likes'}`;
}

export default function App() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [likeError, setLikeError] = useState('');

  useEffect(() => {
    fetch('/api/entries')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Failed to load'))))
      .then(setEntries)
      .catch(() => setError('Could not load entries.'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!message.trim()) {
      setError('Please write a message before signing.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong.');
        return;
      }
      setEntries((prev) => [data, ...prev]);
      setMessage('');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLike(id) {
    setLikeError('');
    try {
      const res = await fetch(`/api/entries/${id}/like`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setLikeError(data.error || 'Could not like that message.');
        return;
      }
      setEntries((prev) => prev.map((en) => (en.id === id ? { ...en, likes: data.likes } : en)));
    } catch {
      setLikeError('Could not reach the server. Please try again.');
    }
  }

  return (
    <main className="page">
      <header className="header">
        <span className="logo" aria-hidden="true">📖</span>
        <div>
          <h1>Guestbook</h1>
          <p className="subtitle">Leave a note for everyone who visits.</p>
        </div>
      </header>

      <section className="card" aria-labelledby="sign-heading">
        <h2 id="sign-heading">Sign the guestbook</h2>
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              value={name}
              maxLength={80}
              placeholder="Anonymous"
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="message">Message</label>
            <textarea
              id="message"
              rows={4}
              value={message}
              maxLength={1000}
              placeholder="Say hello…"
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? 'form-error' : undefined}
              onChange={(e) => {
                setMessage(e.target.value);
                if (error && e.target.value.trim()) setError('');
              }}
            />
          </div>
          {error && (
            <p id="form-error" className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Signing…' : 'Sign'}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="entries-heading">
        <h2 id="entries-heading" className="entries-title">
          Entries <span className="count">{entries.length}</span>
        </h2>
        {likeError && (
          <p className="error" role="alert">
            {likeError}
          </p>
        )}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : entries.length === 0 ? (
          <div className="empty">
            <span aria-hidden="true">✍️</span>
            <p>No entries yet. Be the first to sign!</p>
          </div>
        ) : null}
        <ul className="entries" aria-label="Entries">
          {entries.map((entry) => (
            <li key={entry.id} className="entry">
              <div className="entry-head">
                <span className="avatar" aria-hidden="true">
                  {entry.name.charAt(0).toUpperCase()}
                </span>
                <strong className="entry-name">{entry.name}</strong>
                <time className="muted" dateTime={new Date(entry.createdAt).toISOString()}>
                  {dateFmt.format(new Date(entry.createdAt))}
                </time>
              </div>
              <p className="entry-message">{entry.message}</p>
              <div className="entry-foot">
                <button
                  type="button"
                  className={`like-btn${entry.likes > 0 ? ' liked' : ''}`}
                  aria-label={`Like ${entry.name}'s message`}
                  onClick={() => handleLike(entry.id)}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z" />
                  </svg>
                </button>
                <span className="likes" aria-live="polite">
                  {likesLabel(entry.likes ?? 0)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
