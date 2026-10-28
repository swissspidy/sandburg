import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-modal',
  template: `
    <section aria-label="Modal demo">
      <button type="button" (click)="open.set(true)">Open settings</button>
      @if (open()) {
        <div role="dialog" aria-label="Settings" aria-modal="true">
          <p>Settings go here.</p>
          <button type="button" (click)="open.set(false)">Close</button>
        </div>
      }
    </section>
  `,
})
export class ModalFeature {
  readonly open = signal(false);
}
