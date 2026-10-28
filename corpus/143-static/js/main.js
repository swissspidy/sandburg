import { mount as mount0 } from './features/search.js';
import { mount as mount1 } from './features/todo.js';

const settings = globalThis.__APP_SETTINGS__;
document.body.dataset.theme = settings.theme;

const main = document.querySelector('main');
mount0(main);
mount1(main);
