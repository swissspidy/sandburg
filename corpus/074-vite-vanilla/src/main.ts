import './style.css';
import { mount as mount0 } from './features/todo';
import { mount as mount1 } from './features/persist';
import { mount as mount2 } from './features/search';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Study Tracker' }));
mount0(main);
mount1(main);
mount2(main);
document.querySelector('#app')!.append(main);
