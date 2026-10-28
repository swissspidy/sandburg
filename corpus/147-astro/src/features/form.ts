export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Signup');
  section.innerHTML = '<form novalidate><label for="email">Email</label><input id="email" type="email"><button type="submit">Sign up</button></form>';
  const form = section.querySelector('form')!;
  const input = section.querySelector('input')!;
  const show = (role: string, text: string) => {
    section.querySelector('[role="' + role + '"]')?.remove();
    const p = Object.assign(document.createElement('p'), { textContent: text });
    p.setAttribute('role', role);
    role === 'alert' ? form.insertBefore(p, form.lastElementChild) : section.prepend(p);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(input.value)) { show('alert', 'Please enter a valid email'); return; }
    section.querySelector('[role="alert"]')?.remove();
    show('status', 'Thanks for signing up!');
  });
  root.append(section);
}
