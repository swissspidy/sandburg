import { useState } from 'react';

type Todo = { id: number; text: string; done: boolean };

export default function App() {
  const [count, setCount] = useState(0);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [draft, setDraft] = useState('');

  function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setTodos((t) => [...t, { id: Date.now(), text, done: false }]);
    setDraft('');
  }

  return (
    <main>
      <h1>Counter and todos</h1>
      <section>
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          count is {count}
        </button>
      </section>
      <section>
        <form onSubmit={addTodo}>
          <label htmlFor="todo">New todo</label>
          <input id="todo" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit">Add</button>
        </form>
        <ul aria-label="Todos">
          {todos.map((todo) => (
            <li key={todo.id}>
              <label>
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => setTodos((t) => t.map((x) => (x.id === todo.id ? { ...x, done: !x.done } : x)))}
                />
                {todo.text}
              </label>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
