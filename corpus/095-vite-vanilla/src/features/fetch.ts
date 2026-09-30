const budget: number = 'unlimited';
void budget;
export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Products');
  section.innerHTML = '<p>Loading…</p>';
  root.append(section);
  fetch('/data/products.json')
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      const ul = document.createElement('ul');
      for (const p of data.products) ul.append(Object.assign(document.createElement('li'), { textContent: p.name + ' — $' + p.price }));
      section.replaceChildren(ul);
    })
    .catch((e) => { section.innerHTML = ''; const p = Object.assign(document.createElement('p'), { textContent: 'Failed to load products: ' + e }); p.setAttribute('role', 'alert'); section.append(p); });
}
