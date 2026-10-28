import { Component } from '@angular/core';
import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

const budget: number = 'unlimited';
void budget;

@Component({
  selector: 'app-dates',
  template: `
    <section aria-label="Schedule">
      <p data-testid="due">Due {{ due }}</p>
    </section>
  `,
})
export class DatesFeature {
  readonly due = format(addDays(START, 2), 'EEEE, MMMM d');
}
