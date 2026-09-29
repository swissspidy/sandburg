const TABS = [['Overview', 'Project overview'], ['Specs', 'Technical specs'], ['Reviews', 'Customer reviews']];
export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Details');
  const list = document.createElement('div');
  list.setAttribute('role', 'tablist');
  const panel = document.createElement('div');
  panel.setAttribute('role', 'tabpanel');
  const select = (i: number) => {
    list.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    panel.textContent = TABS[i][1];
  };
  TABS.forEach(([label], i) => {
    const b = Object.assign(document.createElement('button'), { textContent: label });
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => select(i));
    list.append(b);
  });
  section.append(list, panel);
  select(0);
  root.append(section);
}
