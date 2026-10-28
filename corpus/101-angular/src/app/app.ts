import { Component } from '@angular/core';
import { ConverterFeature } from './features/converter';
import { DatesFeature } from './features/dates';

@Component({
  selector: 'app-root',
  imports: [ConverterFeature, DatesFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-converter />
      <app-dates />
    </main>
  `,
})
export class App {
  protected readonly title = 'Music Tracker';
}
