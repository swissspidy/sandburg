import { Component, computed, signal } from '@angular/core';

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

@Component({
  selector: 'app-search',
  template: `
    <section aria-label="Search">
      <input #box type="search" aria-label="Search fruits" [value]="q()" (input)="q.set(box.value)" />
      <ul aria-label="Results">
        @for (f of shown(); track f) {
          <li>{{ f }}</li>
        }
      </ul>
    </section>
  `,
})
export class SearchFeature {
  readonly q = signal('');
  readonly shown = computed(() => FRUITS.filter((f) => f.toLowerCase().includes(this.q().toLowerCase())));
}
