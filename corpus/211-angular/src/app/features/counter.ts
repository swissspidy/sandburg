import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: `
    <section aria-label="Counter">
      <p data-testid="count">Count: {{ count() }}</p>
      <button type="button" (click)="increment()">Increment</button>
      <button type="button" (click)="count.set(0)">Reset</button>
    </section>
  `,
})
export class CounterFeature {
  readonly count = signal(0);

  increment(): void {
    this.count.update((c) => c + 1);
  }
}
