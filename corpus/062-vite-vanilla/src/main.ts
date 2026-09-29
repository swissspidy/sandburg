import './style.css';
import { mount as mount0 } from './features/form';
import { mount as mount1 } from './features/modal';
import { mount as mount2 } from './features/fetch';
import { mount as mount3 } from './features/tabs';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Pantry Tracker' }));
mount0(main);
mount1(main);
mount2(main);
mount3(main);
document.querySelector('#app')!.append(main);
