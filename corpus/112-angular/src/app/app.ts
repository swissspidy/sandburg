import { Component } from '@angular/core';
import { DatesFeature } from './features/dates';
import { TodoFeature } from './features/todo';

@Component({
  selector: 'app-root',
  imports: [DatesFeature, TodoFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-dates />
      <app-todo />
    </main>
  `,
})
export class App {
  protected readonly title = 'Workout Tracker';
}
