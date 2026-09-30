export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

let nextId = 1;

/** A rune-based store shared by components (a .svelte.ts module). */
export const todos = $state<Todo[]>([]);

export function addTodo(text: string) {
  todos.push({ id: nextId++, text, done: false });
}

export function remaining() {
  return todos.filter((t) => !t.done).length;
}
