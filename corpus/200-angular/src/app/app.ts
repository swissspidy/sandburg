import { Component } from '@angular/core';
import { FormFeature } from './features/form';
import { CounterFeature } from './features/counter';

@Component({
  selector: 'app-root',
  imports: [FormFeature, CounterFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-form />
      <app-counter />
    </main>
  `,
})
export class App {
  protected readonly title = 'Budget Tracker';
}
