import { Component } from '@angular/core';
import { TabsFeature } from './features/tabs';
import { CounterFeature } from './features/counter';
import { ModalFeature } from './features/modal';
import { TodoFeature } from './features/todo';

@Component({
  selector: 'app-root',
  imports: [TabsFeature, CounterFeature, ModalFeature, TodoFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-tabs />
      <app-counter />
      <app-modal />
      <app-todo />
    </main>
  `,
})
export class App {
  protected readonly title = 'Movie Tracker';
}
