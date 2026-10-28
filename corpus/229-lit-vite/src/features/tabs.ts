import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

const TABS = [
  { id: 'overview', label: 'Overview', body: 'Project overview' },
  { id: 'specs', label: 'Specs', body: 'Technical specs' },
  { id: 'reviews', label: 'Reviews', body: 'Customer reviews' },
];

@customElement('tabs-feature')
export class TabsFeature extends LitElement {
  @state() private active = 'overview';

  render() {
    const tab = TABS.find((t) => t.id === this.active)!;
    return html`
      <section aria-label="Details">
        <div role="tablist">
          ${TABS.map(
            (t) => html`<button role="tab" aria-selected=${String(t.id === this.active)} @click=${() => (this.active = t.id)}>${t.label}</button>`,
          )}
        </div>
        <div role="tabpanel">${tab.body}</div>
      </section>
    `;
  }
}
