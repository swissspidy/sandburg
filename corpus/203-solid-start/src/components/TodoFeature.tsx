import { createSignal, For } from 'solid-js';

type Todo = { id: number; text: string; done: boolean };

export default function Todos() {
  const [todos, setTodos] = createSignal<Todo[]>([]);
  const [text, setText] = createSignal('');
  function add(e: SubmitEvent) {
    e.preventDefault();
    if (!text().trim()) return;
    setTodos((t) => [...t, { id: t.length + 1, text: text().trim(), done: false }]);
    setText('');
  }
  return (
    <section aria-label="Todos">
      <form onSubmit={add}>
        <label for="todo-input">New todo</label>
        <input id="todo-input" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul aria-label="Todo list">
        <For each={todos()}>
          {(t) => (
            <li>
              <label>
                <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
                {t.text}
              </label>
            </li>
          )}
        </For>
      </ul>
      <p data-testid="remaining">{todos().filter((t) => !t.done).length} remaining</p>
    </section>
  );
}
