export function mount(root: HTMLElement) {
  let count = 0;
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Counter');
  section.innerHTML = '<p data-testid="count">Count: 0</p><button type="button">Increment</button><button type="button">Reset</button>';
  const [inc, reset] = section.querySelectorAll('button');
  const out = section.querySelector('[data-testid="count"]')!;
  inc.addEventListener('click', () => { count += 1; out.textContent = 'Count: ' + count; });
  reset.addEventListener('click', () => { count = 0; out.textContent = 'Count: 0'; });
  root.append(section);
}
