import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

type Product = { id: number; name: string; price: number };

@customElement('fetch-feature')
export class FetchFeature extends LitElement {
  @state() private items: Product[] | null = null;
  @state() private error = '';

  connectedCallback() {
    super.connectedCallback();
    fetch('/data/products.json')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data: { products: Product[] }) => (this.items = data.items))
      .catch((e) => (this.error = String(e)));
  }

  render() {
    if (this.error) return html`<p role="alert">Failed to load products: ${this.error}</p>`;
    if (!this.items) return html`<p>Loading…</p>`;
    return html`
      <section aria-label="Products">
        <ul>
          ${this.items.map((p) => html`<li>${p.name} — $${p.price}</li>`)}
        </ul>
      </section>
    `;
  }
}
