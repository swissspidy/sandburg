import TodoFeature from './components/TodoFeature';
import IconsFeature from './components/IconsFeature';
import ConverterFeature from './components/ConverterFeature';

export default function App() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Chore Tracker</h1>
        <TodoFeature />
        <IconsFeature />
        <ConverterFeature />
      </main>
  );
}
