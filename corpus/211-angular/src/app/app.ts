import { Component } from '@angular/core';
import { DatesFeature } from './features/dates';
import { CounterFeature } from './features/counter';
import { PersistFeature } from './features/persist';

@Component({
  selector: 'app-root',
  imports: [DatesFeature, CounterFeature, PersistFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-dates />
      <app-counter />
      <app-persist />
    </main>
  `,
})
export class App {
  protected readonly title = 'Music Tracker';
}
