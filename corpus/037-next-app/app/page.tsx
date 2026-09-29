import StoreFeature from './components/StoreFeature';
import FormFeature from './components/FormFeature';
import TodoFeature from './components/TodoFeature';
import TailwindModalFeature from './components/TailwindModalFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Habit Tracker</h1>
        <StoreFeature />
        <FormFeature />
        <TodoFeature />
        <TailwindModalFeature />
      </main>
  );
}
