'use client';

import { useState } from 'react';

type Todo = { id: number; text: string; done: boolean };

export default function Todos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');
  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setTodos((t) => [...t, { id: t.length + 1, text: text.trim(), done: false }]);
    setText('');
  }
  return (
    <section aria-label="Todos">
      <form onSubmit={add}>
        <label htmlFor="todo-input">New todo</label>
        <input id="todo-input" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Add todo</button>
      </form>
      <ul aria-label="Todo list">
        {todos.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
              {t.text}
            </label>
          </li>
        ))}
      </ul>
      <p data-testid="remaining">{todos.filter((t) => !t.done).length} remaining</p>
    </section>
  );
}
