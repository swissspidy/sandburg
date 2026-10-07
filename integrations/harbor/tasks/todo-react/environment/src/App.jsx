import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth);
  }, []);
  return (
    <main>
      <h1>Hello</h1>
      {health && <p>SQLite {health.sqlite}</p>}
    </main>
  );
}
