import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('counter-feature')
export class CounterFeature extends LitElement {
  @state() private count = 0;

  render() {
    return html`
      <section aria-label="Counter">
        <p data-testid="count">Count: ${this.count}</p>
        <button type="button" @click=${() => (this.count += 1)}>Increment</button>
        <button type="button" @click=${() => (this.count = 0)}>Reset</button>
      </section>
    `;
  }
}
