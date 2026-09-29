import TodoFeature from '../components/TodoFeature';
import ConverterFeature from '../components/ConverterFeature';
import StoreFeature from '../components/StoreFeature';
import TailwindModalFeature from '../components/TailwindModalFeature';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
        <h1 className="text-2xl font-bold">Travel Tracker</h1>
        <TodoFeature />
        <ConverterFeature />
        <StoreFeature />
        <TailwindModalFeature />
      </main>
  );
}
