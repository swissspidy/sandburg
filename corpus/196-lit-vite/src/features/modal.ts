import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('modal-feature')
export class ModalFeature extends LitElement {
  @state() private open = false;

  render() {
    return html`
      <section aria-label="Modal demo">
        <button type="button" @click=${() => (this.open = true)}>Open settings</button>
        ${this.open
          ? html`<div role="dialog" aria-label="Settings" aria-modal="true">
              <p>Settings go here.</p>
              <button type="button" @click=${() => (this.open = true)}>Close</button>
            </div>`
          : nothing}
      </section>
    `;
  }
}
