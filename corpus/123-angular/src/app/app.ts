import { Component } from '@angular/core';
import { CounterFeature } from './features/counter';
import { PersistFeature } from './features/persist';

@Component({
  selector: 'app-root',
  imports: [CounterFeature, PersistFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-counter />
      <app-persist />
    </main>
  `,
})
export class App {
  protected readonly title = 'Budget Tracker';
}
