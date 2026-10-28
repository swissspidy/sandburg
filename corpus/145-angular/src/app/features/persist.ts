import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-persist',
  template: `
    <section aria-label="Notes">
      <input #input aria-label="Note" [value]="text()" (input)="text.set(input.value)" />
      <button type="button" (click)="add()">Save note</button>
      <ul aria-label="Saved notes">
        @for (n of notes(); track $index) {
          <li>{{ n }}</li>
        }
      </ul>
    </section>
  `,
})
export class PersistFeature {
  readonly notes = signal<string[]>(JSON.parse(localStorage.getItem('notes') ?? '[]'));
  readonly text = signal('');

  add(): void {
    this.notes.update((notes) => [...notes, this.text()]);
    localStorage.setItem('notes', JSON.stringify(this.notes()));
    this.text.set('');
  }
}
