import { useEffect, useState, type FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { addBookmark, listBookmarks, type Bookmark } from './api';

export default function App() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    listBookmarks().then(setBookmarks);
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const created = await addBookmark(title, url);
      setBookmarks((b) => [...b, created]);
      setTitle('');
      setUrl('');
    } catch (err) {
      setError(isAxiosError(err) ? err.response?.data?.error ?? err.message : String(err));
    }
  }

  return (
    <main>
      <h1>Bookmarks</h1>
      <form onSubmit={onSubmit}>
        <label>
          Title <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          URL <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <button type="submit">Save</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p role="status">{bookmarks.length} saved</p>
      <ul>
        {bookmarks.map((b) => (
          <li key={b.id}>
            <a href={b.url}>{b.title}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
