import { useMemo, useState } from 'react';

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

export default function Search() {
  const [q, setQ] = useState('');
  const shown = useMemo(() => FRUITS.filter((f) => f.includes(q)), [q]);
  return (
    <section aria-label="Search">
      <input type="search" aria-label="Search fruits" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul aria-label="Results">{shown.map((f) => <li key={f}>{f}</li>)}</ul>
    </section>
  );
}
