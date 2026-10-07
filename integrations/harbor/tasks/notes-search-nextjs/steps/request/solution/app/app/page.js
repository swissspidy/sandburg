import { listNotes } from '../lib/db.js';
import NotesApp from './NotesApp.js';

// Rendered on each request (it reads the database).
export const dynamic = 'force-dynamic';

export default function Page() {
  const notes = listNotes();
  return (
    <main className="wrap">
      <header className="header">
        <h1>
          <span aria-hidden="true">🗒️</span> Notes
        </h1>
        <p className="sub">Jot things down. Find them again.</p>
      </header>
      <NotesApp notes={notes} />
    </main>
  );
}
