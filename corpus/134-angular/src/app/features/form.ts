import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-form',
  template: `
    <section aria-label="Signup">
      @if (done()) {
        <p role="status">Thanks for signing up!</p>
      }
      <form novalidate (submit)="submit($event)">
        <label for="email">Email</label>
        <input #input id="email" type="email" [value]="email()" (input)="email.set(input.value)" />
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        <button type="submit">Sign up</button>
      </form>
    </section>
  `,
})
export class FormFeature {
  readonly email = signal('');
  readonly error = signal('');
  readonly done = signal(false);

  submit(event: Event): void {
    event.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(this.email())) {
      this.error.set('Please enter a valid email');
      return;
    }
    this.error.set('');
    this.done.set(true);
  }
}
