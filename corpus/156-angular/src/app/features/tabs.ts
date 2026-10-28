import { Component, computed, signal } from '@angular/core';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

@Component({
  selector: 'app-tabs',
  template: `
    <section aria-label="Details">
      <div role="tablist">
        @for (t of tabs; track t.id) {
          <button role="tab" [attr.aria-selected]="t.id === active()" (click)="active.set(t.id)">{{ t.label }}</button>
        }
      </div>
      <div role="tabpanel">{{ tab().body }}</div>
    </section>
  `,
})
export class TabsFeature {
  readonly tabs = TABS;
  readonly active = signal('overview');
  readonly tab = computed(() => TABS.find((t) => t.id === this.active())!);
}
