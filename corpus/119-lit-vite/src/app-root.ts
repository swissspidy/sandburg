import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/form';
import './features/fetch';
import './features/todo';
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
    const settings = (globalThis as any).__APP_SETTINGS__;
    const theme = settings.theme;
    return html`
      <main data-theme=${theme}>
        <h1>Music Tracker</h1>
        <form-feature></form-feature>
        <fetch-feature></fetch-feature>
        <todo-feature></todo-feature>
        <modal-feature></modal-feature>
      </main>
    `;
  }
}
