import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];

import dayjs from 'dayjs';
const today = dayjs().format('YYYY-MM-DD');
void today;

@customElement('search-feature')
export class SearchFeature extends LitElement {
  @state() private q = '';

  render() {
    const q = this.q;
    return html`
      <section aria-label="Search">
        <input type="search" aria-label="Search fruits" .value=${q} @input=${(e: InputEvent) => (this.q = (e.target as HTMLInputElement).value)} />
        <ul aria-label="Results">
          ${FRUITS.filter((f) => f.toLowerCase().includes(q.toLowerCase())).map((f) => html`<li>${f}</li>`)}
        </ul>
      </section>
    `;
  }
}
