import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

type Todo = { id: number; text: string; done: boolean };

@customElement('todo-feature')
export class TodoFeature extends LitElement {
  @state() private todos: Todo[] = [];
  @state() private text = '';

  private add(e: SubmitEvent) {
    e.preventDefault();
    if (!this.text.trim()) return;
    this.todos = [...this.todos, { id: this.todos.length + 1, text: this.text.trim(), done: false }];
    this.text = '';
  }

  private toggle(id: number) {
    this.todos = this.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  }

  render() {
    return html`
      <section aria-label="Todos">
        <form @submit=${this.add}>
          <label for="todo-input">New todo</label>
          <input id="todo-input" .value=${this.text} @input=${(e: InputEvent) => (this.text = (e.target as HTMLInputElement).value)} />
          <button type="submit">Add todo</button>
        </form>
        <ul aria-label="Todo list">
          ${this.todos.map(
            (t) => html`<li><label><input type="checkbox" .checked=${t.done} @change=${() => this.toggle(t.id)} />${t.text}</label></li>`,
          )}
        </ul>
        <p data-testid="remaining">${this.todos.filter((t) => !t.done).length} remaining</p>
      </section>
    `;
  }
}
