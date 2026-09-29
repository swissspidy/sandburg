import './style.css';
import { mount as mount0 } from './features/tabs';
import { mount as mount1 } from './features/todo';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Travel Tracker' }));
mount0(main);
mount1(main);
document.querySelector('#app')!.append(main);
