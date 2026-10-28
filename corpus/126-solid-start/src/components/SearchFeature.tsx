import { createSignal, For } from 'solid-js';

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

export default function Search() {
  const [q, setQ] = createSignal('');
  const shown = () => FRUITS.filter((f) => f.toLowerCase().includes(q().toLowerCase()));
  return (
    <section aria-label="Search">
      <input type="search" aria-label="Search fruits" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      <ul aria-label="Results">
        <For each={shown()}>{(f) => <li>{f}</li>}</For>
      </ul>
    </section>
  );
}
