import db from '../lib/db.js';
import SignForm from './SignForm.js';
import LikeButton from './LikeButton.js';

// Rendered on each request (it reads the database).
export const dynamic = 'force-dynamic';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export default function Page() {
  const entries = db
    .prepare('SELECT id, name, message, created_at, likes FROM entries ORDER BY id DESC')
    .all();

  return (
    <main className="container">
      <header className="page-header">
        <h1>
          <span aria-hidden="true">📖</span> Guestbook
        </h1>
        <p className="subtitle">Stop by and leave a message for everyone to see.</p>
      </header>

      <SignForm />

      <section className="entries-section" aria-labelledby="entries-heading">
        <h2 id="entries-heading" className="section-title">
          Entries <span className="count">{entries.length}</span>
        </h2>

        <ul className="entries" aria-label="Entries">
          {entries.map((e) => (
            <li key={e.id} className="card entry">
              <div
                className="avatar"
                aria-hidden="true"
                style={{ '--h': hue(e.name) }}
              >
                {e.name.charAt(0).toUpperCase()}
              </div>
              <div className="entry-body">
                <div className="entry-head">
                  <strong className="entry-name">{e.name}</strong>
                  <time dateTime={e.created_at} className="entry-time">
                    {dateFormat.format(new Date(e.created_at))} UTC
                  </time>
                </div>
                <p className="entry-message">{e.message}</p>
                <LikeButton id={e.id} name={e.name} likes={Number(e.likes)} />
              </div>
            </li>
          ))}
        </ul>

        {entries.length === 0 && (
          <div className="empty">
            <span aria-hidden="true">✍️</span>
            <p>No entries yet. Be the first to sign!</p>
          </div>
        )}
      </section>
    </main>
  );
}
