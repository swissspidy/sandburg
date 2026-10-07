import { Component, computed, signal } from '@angular/core';

interface Task {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

@Component({
  selector: 'app-root',
  template: `
    <main class="shell">
      <header class="head">
        <h1>To-do</h1>
        @if (tasks().length) {
          <p class="count">{{ remaining() }} of {{ tasks().length }} left</p>
        }
      </header>

      <form class="add" (submit)="add($event)">
        <label for="new-task" class="visually-hidden">New task</label>
        <input
          id="new-task"
          type="text"
          placeholder="What needs doing?"
          autocomplete="off"
          maxlength="500"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
        />
        <button type="submit" class="primary" [disabled]="!draft().trim() || adding()">Add</button>
      </form>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <ul class="list" aria-label="Tasks">
        @for (task of tasks(); track task.id) {
          <li class="item" [class.done]="task.done">
            <input
              type="checkbox"
              [id]="'task-' + task.id"
              [checked]="task.done"
              (change)="toggle(task, $any($event.target).checked)"
            />
            <label [for]="'task-' + task.id">{{ task.text }}</label>
            <button
              type="button"
              class="delete"
              [attr.aria-label]="'Delete ' + task.text"
              [title]="'Delete ' + task.text"
              (click)="remove(task)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
              </svg>
            </button>
          </li>
        }
      </ul>

      @if (loaded() && !tasks().length) {
        <div class="empty">
          <span aria-hidden="true">📝</span>
          <p>No tasks yet. Add your first one above.</p>
        </div>
      }
    </main>
  `,
})
export class App {
  protected readonly tasks = signal<Task[]>([]);
  protected readonly draft = signal('');
  protected readonly adding = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly remaining = computed(() => this.tasks().filter((t) => !t.done).length);

  constructor() {
    this.load();
  }

  private async load() {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) throw new Error();
      this.tasks.set(await res.json());
      this.error.set('');
    } catch {
      this.error.set('Could not load tasks.');
    } finally {
      this.loaded.set(true);
    }
  }

  protected async add(event: Event) {
    event.preventDefault();
    const text = this.draft().trim();
    if (!text || this.adding()) return;
    this.adding.set(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error();
      const task: Task = await res.json();
      this.tasks.update((list) => [...list, task]);
      this.draft.set('');
      this.error.set('');
    } catch {
      this.error.set('Could not add the task.');
    } finally {
      this.adding.set(false);
    }
  }

  protected async toggle(task: Task, done: boolean) {
    this.tasks.update((list) => list.map((t) => (t.id === task.id ? { ...t, done } : t)));
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      });
      if (!res.ok) throw new Error();
      this.error.set('');
    } catch {
      this.tasks.update((list) => list.map((t) => (t.id === task.id ? { ...t, done: !done } : t)));
      this.error.set('Could not update the task.');
    }
  }

  protected async remove(task: Task) {
    const previous = this.tasks();
    this.tasks.update((list) => list.filter((t) => t.id !== task.id));
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      this.error.set('');
    } catch {
      this.tasks.set(previous);
      this.error.set('Could not delete the task.');
    }
  }
}
