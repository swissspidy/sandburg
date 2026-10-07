import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <main>
      <h1>Hello</h1>
      @if (sqlite()) {
        <p>SQLite {{ sqlite() }}</p>
      }
    </main>
  `,
})
export class App {
  protected readonly sqlite = signal('');

  constructor() {
    fetch('/api/health')
      .then((r) => r.json())
      .then((health) => this.sqlite.set(health.sqlite));
  }
}
