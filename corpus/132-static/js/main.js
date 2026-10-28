import { mount as mount0 } from './features/form.js';
import { mount as mount1 } from './features/tabs.js';
import { mount as mount2 } from './features/todo.js';
import { mount as mount3 } from './features/converter.js';

const main = document.querySelector('main');
mount0(main);
mount1(main);
mount2(main);
mount3(main);
