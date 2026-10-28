import { Component } from '@angular/core';
import { CounterFeature } from './features/counter';
import { FormFeature } from './features/form';
import { FetchFeature } from './features/fetch';
import { ConverterFeature } from './features/converter';

@Component({
  selector: 'app-root',
  imports: [CounterFeature, FormFeature, FetchFeature, ConverterFeature],
  template: `
    <main>
      <h1>{{ title }}</h1>
      <app-counter />
      <app-form />
      <app-fetch />
      <app-converter />
    </main>
  `,
})
export class App {
  protected readonly title = 'Reading Tracker';
}
