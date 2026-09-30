import './style.css';
import { mount as mount0 } from './features/form';
import { mount as mount1 } from './features/todo';
import { mount as mount2 } from './features/search';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Music Tracker' }));
mount0(main);
mount1(main);
mount2(main);
document.querySelector('#app')!.append(main);
