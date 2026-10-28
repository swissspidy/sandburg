import { Component, computed, signal } from '@angular/core';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

@Component({
  selector: 'app-todo',
  template: `
    <section aria-label="Todos">
      <form (submit)="add($event)">
        <label for="todo-input">New todo</label>
        <input #input id="todo-input" [value]="text()" (input)="text.set(input.value)" />
        <button type="submit">Add todo</button>
      </form>
      <ul aria-label="Todo list">
        @for (todo of todos(); track todo.id) {
          <li>
            <label><input type="checkbox" [checked]="todo.done" (change)="toggle(todo.id)" /> {{ todo.text }}</label>
          </li>
        }
      </ul>
      <p data-testid="remaining">{{ remaining() }} remaining</p>
    </section>
  `,
})
export class TodoFeature {
  readonly todos = signal<Todo[]>([]);
  readonly text = signal('');
  readonly remaining = computed(() => this.todos().filter((t) => !t.done).length);

  add(event: Event): void {
    event.preventDefault();
    const text = this.text().trim();
    if (!text) return;
    this.todos.update((todos) => [...todos, { id: todos.length + 1, text, done: false }]);
    this.text.set('');
  }

  toggle(id: number): void {
    this.todos.update((todos) => todos.map((t) => (t.id === id ? { ...t, done: t.done } : t)));
  }
}
