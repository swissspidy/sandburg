import { addDays, format } from 'date-fns';

const START = new Date(2025, 0, 30);

const broken = ;

export function mount(root: HTMLElement) {
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Schedule');
  const due = Object.assign(document.createElement('p'), { textContent: 'Due ' + format(addDays(START, 2), 'EEEE, MMMM d') });
  due.dataset.testid = 'due';
  section.append(due);
  root.append(section);
}
