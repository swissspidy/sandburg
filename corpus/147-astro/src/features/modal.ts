export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Modal demo');
  section.innerHTML = '<button type="button">Open settings</button><div role="dialog" aria-label="Settings" aria-modal="true" hidden><p>Settings go here.</p><button type="button">Close</button></div>';
  const [open, close] = section.querySelectorAll('button');
  const dialog = section.querySelector('[role="dialog"]') as HTMLElement;
  open.addEventListener('click', () => { dialog.hidden = false; });
  close.addEventListener('click', () => { dialog.hidden = true; });
  root.append(section);
}
