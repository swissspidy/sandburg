import { Component } from '@angular/core';
import { TodoFeature } from './features/todo';
import { TabsFeature } from './features/tabs';
import { DatesFeature } from './features/dates';

@Component({
  selector: 'app-root',
  imports: [TodoFeature, TabsFeature, DatesFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-todo />
      <app-tabs />
      <app-dates />
    </main>
  `,
})
export class App {
  protected readonly title = 'Pantry Tracker';
}
