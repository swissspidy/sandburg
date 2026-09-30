import TodoFeature from './components/TodoFeature';
import RouterFeature from './components/RouterFeature';
import StoreFeature from './components/StoreFeature';
import SearchFeature from './components/SearchFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Habit Tracker</h1>
        <TodoFeature />
        <RouterFeature />
        <StoreFeature />
        <SearchFeature />
        <TailwindModalFeature />
      </main>
  );
}
