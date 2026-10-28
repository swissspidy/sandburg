import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/todo';
import './features/fetch';
import './features/modal';

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
        <h1>Pantry Tracker</h1>
        <todo-feature></todo-feature>
        <fetch-feature></fetch-feature>
        <modal-feature></modal-feature>
      </main>
    `;
  }
}
