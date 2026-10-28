import { createSignal, For, onMount } from 'solid-js';

export default function Notes() {
  const [notes, setNotes] = createSignal<string[]>([]);
  const [text, setText] = createSignal('');
  onMount(() => {
    const saved = localStorage.getItem('notes');
    if (saved) setNotes(JSON.parse(saved));
  });
  function add() {
    const next = [...notes(), text()];
    setNotes(next);
    localStorage.setItem('notes', JSON.stringify(next));
    setText('');
  }
  return (
    <section aria-label="Notes">
      <input aria-label="Note" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      <button type="button" onClick={add}>Save note</button>
      <ul aria-label="Saved notes">
        <For each={notes()}>{(n) => <li>{n}</li>}</For>
      </ul>
    </section>
  );
}
