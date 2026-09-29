import './style.css';
import { mount as mount0 } from './features/modal';
import { mount as mount1 } from './features/persist';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Budget Tracker' }));
mount0(main);
mount1(main);
document.querySelector('#app')!.append(main);
