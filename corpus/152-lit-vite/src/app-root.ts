import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/counter';
import './features/todo';
import './features/fetch';

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
        <h1>Travel Tracker</h1>
        <counter-feature></counter-feature>
        <todo-feature></todo-feature>
        <fetch-feature></fetch-feature>
      </main>
    `;
  }
}
