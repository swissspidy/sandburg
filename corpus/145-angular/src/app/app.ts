import { Component } from '@angular/core';
import { CounterFeature } from './features/counter';
import { SearchFeature } from './features/search';
import { ConverterFeature } from './features/converter';
import { PersistFeature } from './features/persist';

@Component({
  selector: 'app-root',
  imports: [CounterFeature, SearchFeature, ConverterFeature, PersistFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-counter />
      <app-search />
      <app-converter />
      <app-persist />
    </main>
  `,
})
export class App {
  protected readonly title = 'Movie Tracker';
}
