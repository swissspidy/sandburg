import './style.css';
import { mount as mount0 } from './features/search';
import { mount as mount1 } from './features/modal';

const settings = (globalThis as any).__APP_SETTINGS__;
document.body.dataset.theme = settings.theme;
const main = document.createElement('main');
main.append(Object.assign(document.createElement('h1'), { textContent: 'Habit Tracker' }));
mount0(main);
mount1(main);
document.querySelector('#app')!.append(main);
