import { Component, inject } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TaskItem } from './task-item';
import { TaskStore } from './task-store';
import { PluralPipe } from './plural.pipe';

@Component({
  selector: 'app-task-list',
  imports: [ReactiveFormsModule, TaskItem, PluralPipe],
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
})
export class TaskList {
  protected readonly store = inject(TaskStore);
  protected readonly form = new FormGroup({
    title: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  add(): void {
    const title = this.form.controls.title.value.trim();
    if (!title) return;
    this.store.add(title);
    this.form.reset();
  }
}
