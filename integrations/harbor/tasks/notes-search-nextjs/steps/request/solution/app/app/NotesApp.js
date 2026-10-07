'use client';

import { useRef, useState, useTransition } from 'react';
import { addNote } from './actions.js';

export default function NotesApp({ notes }) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const formRef = useRef(null);
  const titleRef = useRef(null);

  const q = query.trim().toLowerCase();
  const visible = q
    ? notes.filter(
        (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
      )
    : notes;

  function handleSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (!String(fd.get('title')).trim() && !String(fd.get('body')).trim()) {
      setError('Write a title or a body before saving.');
      titleRef.current?.focus();
      return;
    }
    setError('');
    startTransition(async () => {
      const res = await addNote(fd);
      if (res?.ok) {
        formRef.current?.reset();
        titleRef.current?.focus();
      } else {
        setError(res?.error || 'Could not save the note.');
      }
    });
  }

  return (
    <div className="grid">
      <section className="card" aria-labelledby="new-note-heading">
        <h2 id="new-note-heading">New note</h2>
        <form ref={formRef} onSubmit={handleSubmit} className="form">
          <div className="field">
            <label htmlFor="note-title">Title</label>
            <input
              ref={titleRef}
              id="note-title"
              name="title"
              type="text"
              maxLength={200}
              autoComplete="off"
              placeholder="Grocery list"
            />
          </div>
          <div className="field">
            <label htmlFor="note-body">Body</label>
            <textarea
              id="note-body"
              name="body"
              rows={5}
              placeholder="Eggs, milk, coffee…"
            />
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Saving…' : 'Save note'}
          </button>
        </form>
      </section>

      <section className="card" aria-labelledby="notes-heading">
        <div className="list-head">
          <h2 id="notes-heading">
            Your notes <span className="count">{notes.length}</span>
          </h2>
        </div>
        <div className="field search">
          <label htmlFor="note-search">Search</label>
          <input
            id="note-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title or body"
            autoComplete="off"
          />
        </div>

        <ul className="notes" aria-label="Notes">
          {visible.map((n) => (
            <li key={n.id} className="note">
              <h3 className="note-title">{n.title || <span className="muted">Untitled</span>}</h3>
              {n.body && <p className="note-body">{n.body}</p>}
              <time className="note-time" dateTime={n.createdAt.replace(' ', 'T') + 'Z'}>
                {formatDate(n.createdAt)}
              </time>
            </li>
          ))}
        </ul>

        {notes.length === 0 && (
          <div className="empty">
            <span aria-hidden="true" className="empty-icon">📝</span>
            <p>No notes yet. Write your first one.</p>
          </div>
        )}
        {notes.length > 0 && visible.length === 0 && (
          <div className="empty" role="status">
            <span aria-hidden="true" className="empty-icon">🔍</span>
            <p>No notes match “{query.trim()}”.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
