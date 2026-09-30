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
    :host { display: flex; justify-content: space-between; padding: 0.25rem 0; }
    .done { text-decoration: line-through; color: #666; }
  `,
})
export class TaskItem {
  readonly task = input.required<Task>();
  readonly toggled = output<number>();
  readonly removed = output<number>();
}
