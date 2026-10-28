import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/form';
import './features/search';
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
        <h1>Garden Tracker</h1>
        <form-feature></form-feature>
        <search-feature></search-feature>
        <fetch-feature></fetch-feature>
      </main>
    `;
  }
}
