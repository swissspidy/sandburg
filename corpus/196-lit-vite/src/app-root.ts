import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/modal';
import './features/fetch';
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
        <h1>Habit Tracker</h1>
        <modal-feature></modal-feature>
        <fetch-feature></fetch-feature>
        <counter-feature></counter-feature>
      </main>
    `;
  }
}
