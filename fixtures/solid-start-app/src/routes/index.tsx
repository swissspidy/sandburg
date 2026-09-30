import { Title } from '@solidjs/meta';
import { action, createAsync, query, useSubmission } from '@solidjs/router';
import { createSignal, For } from 'solid-js';

const todos: string[] = ['Learn SolidStart'];

const getTodos = query(async () => {
  'use server';
  return { renderedOn: 'the server', todos: [...todos] };
}, 'todos');

const addTodo = action(async (form: FormData) => {
  'use server';
  const title = String(form.get('title') ?? '').trim();
  if (title) todos.push(title);
}, 'addTodo');

export default function Home() {
  const data = createAsync(() => getTodos());
  const [count, setCount] = createSignal(0);
  const adding = useSubmission(addTodo);
  return (
    <>
      <Title>Welcome to SolidStart</Title>
      <h1>Welcome to SolidStart</h1>
      <p>Data from {data()?.renderedOn}.</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Clicked {count()} times
      </button>
      <ul>
        <For each={data()?.todos}>{(t) => <li>{t}</li>}</For>
      </ul>
      <form action={addTodo} method="post">
        <input name="title" aria-label="New todo" />
        <button type="submit" disabled={adding.pending}>
          Add
        </button>
      </form>
    </>
  );
}
