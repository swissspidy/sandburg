import { Component } from '@angular/core';
import { DatesFeature } from './features/dates';
import { SearchFeature } from './features/search';

@Component({
  selector: 'app-root',
  imports: [DatesFeature, SearchFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-dates />
      <app-search />
    </main>
  `,
})
export class App {
  protected readonly title = 'Reading Tracker';
}
