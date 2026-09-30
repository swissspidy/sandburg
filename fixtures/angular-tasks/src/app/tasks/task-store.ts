import { Injectable, computed, signal } from '@angular/core';

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

@Injectable({ providedIn: 'root' })
export class TaskStore {
  private nextId = 3;
  readonly tasks = signal<Task[]>([
    { id: 1, title: 'Write the brief', done: true },
    { id: 2, title: 'Review the draft', done: false },
  ]);
  readonly remaining = computed(() => this.tasks().filter((t) => !t.done).length);

  add(title: string): void {
    this.tasks.update((tasks) => [...tasks, { id: this.nextId++, title, done: false }]);
  }

  toggle(id: number): void {
    this.tasks.update((tasks) => tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  remove(id: number): void {
    this.tasks.update((tasks) => tasks.filter((t) => t.id !== id));
  }
}
