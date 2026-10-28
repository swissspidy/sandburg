import { createSignal, For, Match, onMount, Switch } from 'solid-js';

type Product = { id: number; name: string; price: number };

export default function Products(props: { source: string }) {
  const [items, setItems] = createSignal<Product[] | null>(null);
  const [error, setError] = createSignal('');
  onMount(() => {
    fetch(props.source)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => setItems(data.products))
      .catch((e) => setError(String(e)));
  });
  return (
    <Switch>
      <Match when={error()}>
        <p role="alert">Failed to load products: {error()}</p>
      </Match>
      <Match when={!items()}>
        <p>Loading…</p>
      </Match>
      <Match when={items()}>
        {(list) => (
          <section aria-label="Products">
            <ul>
              <For each={list()}>{(p) => <li>{p.name} — ${p.price}</li>}</For>
            </ul>
          </section>
        )}
      </Match>
    </Switch>
  );
}
