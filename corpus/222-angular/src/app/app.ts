import { Component } from '@angular/core';
import { TodoFeature } from './features/todo';
import { TabsFeature } from './features/tabs';
import { SearchFeature } from './features/search';

@Component({
  selector: 'app-root',
  imports: [TodoFeature, TabsFeature, SearchFeature],
  template: `
    <main [attr.data-theme]="theme">
      <h1>{{ title }}</h1>
      <app-todo />
      <app-tabs />
      <app-search />
    </main>
  `,
})
export class App {
  protected readonly title = 'Recipe Tracker';
  private readonly settings = (globalThis as any).__APP_SETTINGS__;
  protected readonly theme = this.settings.theme;
}
