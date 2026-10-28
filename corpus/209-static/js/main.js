import { mount as mount0 } from './features/converter.js';
import { mount as mount1 } from './features/counter.js';
import { mount as mount2 } from './features/search.js';
import { mount as mount3 } from './features/fetch.js';

const main = document.querySelector('main');
mount0(main);
mount1(main);
mount2(main);
mount3(main);
