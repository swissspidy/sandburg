import { mount as mount0 } from './features/persist.js';
import { mount as mount1 } from './features/modal.js';
import { mount as mount2 } from './features/fetch.js';

const main = document.querySelector('main');
mount0(main);
mount1(main);
mount2(main);
