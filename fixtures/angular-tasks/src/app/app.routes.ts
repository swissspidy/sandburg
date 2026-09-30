import { Routes } from '@angular/router';
import { TaskList } from './tasks/task-list';

export const routes: Routes = [
  { path: '', component: TaskList, title: 'Tasks' },
  // Lazy: its own chunk, loaded on navigation.
  { path: 'about', loadComponent: () => import('./about/about').then((m) => m.About), title: 'About' },
  { path: '**', redirectTo: '' },
];
