const FRUITS = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango'];
export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Search');
  section.innerHTML = '<input type="search" aria-label="Search fruits"><ul aria-label="Results"></ul>';
  const input = section.querySelector('input')!;
  const list = section.querySelector('ul')!;
  const render = () => {
    const q = input.value;
    list.replaceChildren(...FRUITS.filter((f) => f.toLowerCase().includes(q.toLowerCase())).map((f) => Object.assign(document.createElement('li'), { textContent: f })));
  };
  input.addEventListener('input', render);
  render();
  root.append(section);
}
