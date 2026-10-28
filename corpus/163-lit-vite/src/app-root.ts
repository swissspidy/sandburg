import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/converter';
import './features/modal';
import './features/form';
import './features/counter';

@customElement('app-root')
export class AppRoot extends LitElement {
  static styles = css`
    main {
      max-width: 40rem;
      margin: 2rem auto;
      padding: 0 1rem;
    }
  `;

  render() {
    return html`
      <main>
        <h1>Study Tracker</h1>
        <converter-feature></converter-feature>
        <modal-feature></modal-feature>
        <form-feature></form-feature>
        <counter-feature></counter-feature>
      </main>
    `;
  }
}
