import { useState } from 'react';
import { Form } from 'react-router';
import type { Route } from './+types/home';

const todos: string[] = ['Learn React Router'];

export function meta() {
  return [{ title: 'Welcome to React Router' }];
}

export async function loader() {
  return { renderedAt: 'the server loader', todos };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const title = String(form.get('title') ?? '').trim();
  if (title) todos.push(title);
  return null;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const [count, setCount] = useState(0);
  return (
    <>
      <h1>Welcome to React Router</h1>
      <p>Data from {loaderData.renderedAt}.</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} times
      </button>
      <ul>
        {loaderData.todos.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <Form method="post">
        <input name="title" aria-label="New todo" />
        <button type="submit">Add</button>
      </Form>
    </>
  );
}
