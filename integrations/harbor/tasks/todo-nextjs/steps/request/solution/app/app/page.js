import { listTasks } from '../lib/db.js';
import TodoApp from './TodoApp.js';

// Rendered on each request (it reads the database).
export const dynamic = 'force-dynamic';

export default function Page() {
  const tasks = listTasks();
  return (
    <main className="container">
      <header className="page-header">
        <h1>To-do</h1>
        <p className="subtitle">Keep track of what needs doing.</p>
      </header>
      <TodoApp initialTasks={tasks} />
    </main>
  );
}
