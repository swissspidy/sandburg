import { Component, input, output } from '@angular/core';
import { Task } from './task-store';

@Component({
  selector: 'app-task-item',
  template: `
    <label [class.done]="task().done">
      <input type="checkbox" [checked]="task().done" (change)="toggled.emit(task().id)" />
      {{ task().title }}
    </label>
    <button type="button" [attr.aria-label]="'Delete ' + task().title" (click)="removed.emit(task().id)">×</button>
  `,
  styles: `
    :host { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.6rem 0; }
    label { display: flex; align-items: center; gap: 0.6rem; cursor: pointer; }
    input { width: 1rem; height: 1rem; accent-color: var(--accent); }
    .done { text-decoration: line-through; color: var(--muted); }
    button { width: 2rem; height: 2rem; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-size: 1.25rem; line-height: 1; cursor: pointer; }
    button:hover { background: var(--bg); color: var(--accent); }
  `,
})
export class TaskItem {
  readonly task = input.required<Task>();
  readonly toggled = output<number>();
  readonly removed = output<number>();
}
