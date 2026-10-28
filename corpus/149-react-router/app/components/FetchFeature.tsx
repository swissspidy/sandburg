import { useEffect, useState } from 'react';

type Product = { id: number; name: string; price: number };

export default function Products({ source }: { source: string }) {
  const [items, setItems] = useState<Product[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(source)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => setItems(data.products))
      .catch((e) => setError(String(e)));
  }, [source]);
  if (error) return <p role="alert">Failed to load products: {error}</p>;
  if (!items) return <p>Loading…</p>;
  return (
    <section aria-label="Products">
      <ul>{items.map((p) => <li key={p.id}>{p.name} — ${p.price}</li>)}</ul>
    </section>
  );
}
