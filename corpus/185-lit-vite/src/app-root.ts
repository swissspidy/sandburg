import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/form';
import './features/converter';
import './features/persist';
import './features/dates';

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
        <h1>Habit Tracker</h1>
        <form-feature></form-feature>
        <converter-feature></converter-feature>
        <persist-feature></persist-feature>
        <dates-feature></dates-feature>
      </main>
    `;
  }
}
