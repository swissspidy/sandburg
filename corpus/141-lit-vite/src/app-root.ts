import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import './features/search';
import './features/form';

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
        <h1>Music Tracker</h1>
        <search-feature></search-feature>
        <form-feature></form-feature>
      </main>
    `;
  }
}
