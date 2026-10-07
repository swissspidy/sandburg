import db from '../lib/db.js';

// Rendered on each request (it reads the database).
export const dynamic = 'force-dynamic';

export default function Page() {
  const { version } = db.prepare('select sqlite_version() as version').get();
  return (
    <main>
      <h1>Hello</h1>
      <p>SQLite {version}</p>
    </main>
  );
}
