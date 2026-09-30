export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Notes');
  section.innerHTML = '<input aria-label="Note"><button type="button">Save note</button><ul aria-label="Saved notes"></ul>';
  const input = section.querySelector('input')!;
  const list = section.querySelector('ul')!;
  let notes: string[] = JSON.parse(localStorage.getItem('notes') ?? '[]');
  const render = () => list.replaceChildren(...notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
  section.querySelector('button')!.addEventListener('click', () => {
    notes = [...notes, input.value];
    
    input.value = '';
    render();
  });
  render();
  root.append(section);
}
