const broken = ;
export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Todos');
  section.innerHTML = '<form><label for="todo-input">New todo</label><input id="todo-input"><button type="submit">Add todo</button></form><ul aria-label="Todo list"></ul><p data-testid="remaining">0 remaining</p>';
  const form = section.querySelector('form')!;
  const input = section.querySelector('input')!;
  const list = section.querySelector('ul')!;
  const remaining = section.querySelector('[data-testid="remaining"]')!;
  const update = () => { remaining.textContent = list.querySelectorAll('input:not(:checked)').length + ' remaining'; };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', update);
    label.append(box, input.value.trim());
    li.append(label);
    list.append(li);
    input.value = '';
    update();
  });
  root.append(section);
}
