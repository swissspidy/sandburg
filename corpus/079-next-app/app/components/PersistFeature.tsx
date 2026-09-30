'use client';

import { useEffect, useState } from 'react';

export default function Notes() {
  const [notes, setNotes] = useState<string[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    const saved = localStorage.getItem('notes');
    if (saved) setNotes(JSON.parse(saved));
  }, []);
  function add() {
    const next = [...notes, text];
    setNotes(next);
    localStorage.setItem('notes', JSON.stringify(next));
    setText('');
  }
  return (
    <section aria-label="Notes">
      <input aria-label="Note" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" onClick={add}>Save note</button>
      <ul aria-label="Saved notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </section>
  );
}
