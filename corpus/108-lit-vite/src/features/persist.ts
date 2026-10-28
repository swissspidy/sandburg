import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('persist-feature')
export class PersistFeature extends LitElement {
  @state() private notes: string[] = JSON.parse(localStorage.getItem('notes') ?? '[]');
  @state() private text = '';

  private add() {
    this.notes = [...this.notes, this.text];
    localStorage.setItem('notes', JSON.stringify(this.notes));
    this.text = '';
  }

  render() {
    return html`
      <section aria-label="Notes">
        <input aria-label="Note" .value=${this.text} @input=${(e: InputEvent) => (this.text = (e.target as HTMLInputElement).value)} />
        <button type="button" @click=${this.add}>Save note</button>
        <ul aria-label="Saved notes">
          ${this.notes.map((n) => html`<li>${n}</li>`)}
        </ul>
      </section>
    `;
  }
}
