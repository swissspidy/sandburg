import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

const budget: number = 'unlimited';
void budget;

@customElement('form-feature')
export class FormFeature extends LitElement {
  @state() private email = '';
  @state() private error = '';
  @state() private done = false;

  private submit(e: SubmitEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(this.email)) { this.error = 'Please enter a valid email'; return; }
    this.error = '';
    this.done = true;
  }

  render() {
    return html`
      <section aria-label="Signup">
        ${this.done ? html`<p role="status">Thanks for signing up!</p>` : nothing}
        <form novalidate @submit=${this.submit}>
          <label for="email">Email</label>
          <input id="email" type="email" .value=${this.email} @input=${(e: InputEvent) => (this.email = (e.target as HTMLInputElement).value)} />
          ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
          <button type="submit">Sign up</button>
        </form>
      </section>
    `;
  }
}
