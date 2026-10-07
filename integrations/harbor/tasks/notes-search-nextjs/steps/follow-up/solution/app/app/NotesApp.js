'use client';

import { useOptimistic, useRef, useState, useTransition } from 'react';
import { addNote, setNotePinned } from './actions.js';

function sortNotes(list) {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.id - a.id;
  });
}

export default function NotesApp({ notes }) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const [, startPinTransition] = useTransition();
  const [optimisticNotes, applyPin] = useOptimistic(notes, (state, { id, pinned }) =>
    state.map((n) => (n.id === id ? { ...n, pinned } : n))
  );
  const formRef = useRef(null);
  const titleRef = useRef(null);

  const ordered = sortNotes(optimisticNotes);
  const q = query.trim().toLowerCase();
  const visible = q
    ? ordered.filter(
        (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
      )
    : ordered;

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

  function togglePin(note) {
    const next = !note.pinned;
    startPinTransition(async () => {
      applyPin({ id: note.id, pinned: next });
      await setNotePinned(note.id, next);
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
          {visible.map((n) => {
            const name = n.title || 'Untitled';
            return (
              <li key={n.id} className={n.pinned ? 'note pinned' : 'note'}>
                <div className="note-head">
                  <h3 className="note-title">
                    {n.title || <span className="muted">Untitled</span>}
                  </h3>
                  <button
                    type="button"
                    className={n.pinned ? 'pin-btn on' : 'pin-btn'}
                    onClick={() => togglePin(n)}
                    aria-label={`${n.pinned ? 'Unpin' : 'Pin'} ${name}`}
                    title={n.pinned ? 'Unpin' : 'Pin'}
                  >
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill={n.pinned ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                    <span aria-hidden="true">{n.pinned ? 'Unpin' : 'Pin'}</span>
                  </button>
                </div>
                {n.body && <p className="note-body">{n.body}</p>}
                <time className="note-time" dateTime={n.createdAt.replace(' ', 'T') + 'Z'}>
                  {n.pinned && <span className="pinned-tag">Pinned · </span>}
                  {formatDate(n.createdAt)}
                </time>
              </li>
            );
          })}
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
