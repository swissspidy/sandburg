import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('converter-feature')
export class ConverterFeature extends LitElement {
  @state() private celsius = '0';

  render() {
    const f = (Number(this.celsius) * 9) / 5 + 32;
    return html`
      <section aria-label="Converter">
        <label for="celsius">Celsius</label>
        <input id="celsius" type="number" .value=${this.celsius} @input=${(e: InputEvent) => (this.celsius = (e.target as HTMLInputElement).value)} />
        <output data-testid="fahrenheit">${Number.isFinite(f) ? f.toFixed(1) : '—'} °F</output>
      </section>
    `;
  }
}
