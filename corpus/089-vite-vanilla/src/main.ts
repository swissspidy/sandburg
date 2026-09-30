import './style.css';
import { mount as mount0 } from './features/search';
import { mount as mount1 } from './features/persist';
import { mount as mount2 } from './features/fetch';

const settings = (globalThis as any).__APP_SETTINGS__;
document.body.dataset.theme = settings.theme;
const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Music Tracker' }));
mount0(main);
mount1(main);
mount2(main);
document.querySelector('#app')!.append(main);
