import { Component } from '@angular/core';
import { DatePipe } from '@angular/common';

@Component({
  selector: 'app-about',
  imports: [DatePipe],
  template: `
    <h2>About</h2>
    <p>A small task board, built with Angular.</p>
    <p>Released {{ released | date: 'longDate' }}.</p>
  `,
})
export class About {
  protected readonly released = new Date(2026, 8, 30);
}
