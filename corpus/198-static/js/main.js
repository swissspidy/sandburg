import { mount as mount0 } from './features/todo.js';
import { mount as mount1 } from './features/converter.js';
import { mount as mount2 } from './features/modal.js';

const main = document.querySelector('main');
mount0(main);
mount1(main);
mount2(main);
