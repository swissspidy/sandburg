import './style.css';
import { mount as mount0 } from './features/fetch';
import { mount as mount1 } from './features/search';
import { mount as mount2 } from './features/form';

const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Recipe Tracker' }));
mount0(main);
mount1(main);
mount2(main);
document.querySelector('#app')!.append(main);
