import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

@customElement('dates-feature')
export class DatesFeature extends LitElement {
  render() {
    return html`
      <section aria-label="Schedule">
        <p data-testid="due">Due ${format(addDays(START, 2), 'EEEE, MMMM d')}</p>
      </section>
    `;
  }
}
