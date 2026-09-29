import './style.css';
import { mount as mount0 } from './features/modal';
import { mount as mount1 } from './features/todo';
import { mount as mount2 } from './features/search';
import { mount as mount3 } from './features/fetch';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Reading Tracker' }));
mount0(main);
mount1(main);
mount2(main);
mount3(main);
document.querySelector('#app')!.append(main);
