import './style.css';
import { mount as mount0 } from './features/form';
import { mount as mount1 } from './features/counter';
import { mount as mount2 } from './features/tabs';
import { mount as mount3 } from './features/fetch';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Chore Tracker' }));
mount0(main);
mount1(main);
mount2(main);
mount3(main);
document.querySelector('#app')!.append(main);
