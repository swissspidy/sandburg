import { Component } from '@angular/core';
import { TodoFeature } from './features/todo';
import { ModalFeature } from './features/modal';
import { FetchFeature } from './features/fetch';

@Component({
  selector: 'app-root',
  imports: [TodoFeature, ModalFeature, FetchFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-todo />
      <app-modal />
      <app-fetch />
    </main>
  `,
})
export class App {
  protected readonly title = 'Study Tracker';
}
