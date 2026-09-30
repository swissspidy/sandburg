import TailwindModalFeature from './components/TailwindModalFeature';
import FetchFeature from './components/FetchFeature';
import TodoFeature from './components/TodoFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Travel Tracker</h1>
        <TailwindModalFeature />
        <FetchFeature source="/api/products" />
        <TodoFeature />
      </main>
  );
}
