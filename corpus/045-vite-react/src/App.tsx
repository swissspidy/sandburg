import RouterFeature from './components/RouterFeature';
import TodoFeature from './components/TodoFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Recipe Tracker</h1>
        <RouterFeature />
        <TodoFeature />
        <TailwindModalFeature />
      </main>
  );
}
